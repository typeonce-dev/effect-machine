import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as DevToolsProtocol from "../src/DevToolsProtocol.js"
import { parseCandidate } from "../src/internal/projectInspector.js"
import * as ProjectInspector from "../src/ProjectInspector.js"

describe("ProjectInspector", () => {
  it("finds handle calls and records direct machine exports", () => {
    assert.deepStrictEqual(
      parseCandidate(
        "src/workflow.ts",
        `
          const builder = Machine.make({})
          export const workflow = builder.handle({})
          const internal = builder["handle"]({})
        `
      ),
      { file: "src/workflow.ts", exportNames: ["workflow"] }
    )
    assert.isUndefined(parseCandidate("src/value.ts", "export const value = 1"))
  })

  it.effect("discovers and evaluates an exported machine in an isolated worker", () =>
    Effect.gen(function*() {
      const inspector = yield* ProjectInspector.ProjectInspector
      const results = yield* inspector.inspect({
        root: process.cwd(),
        include: "packages/devtools/src/internal/browser/example-machine.ts",
        revision: 7
      })

      assert.strictEqual(results.length, 1)
      const result = results[0]
      assert.strictEqual(result?._tag, "Ready")
      if (result?._tag === "Ready") {
        assert.strictEqual(result.document.machineId, "inspection-example")
        assert.strictEqual(result.document.revision, 7)
        assert.deepStrictEqual(result.document.source, {
          file: "packages/devtools/src/internal/browser/example-machine.ts",
          exportName: "machine"
        })
      }
    }).pipe(Effect.provide(ProjectInspector.layer)))

  it.effect("returns a failed result when one candidate cannot be loaded", () =>
    Effect.gen(function*() {
      const inspector = yield* ProjectInspector.ProjectInspector
      const results = yield* inspector.evaluate(
        [{
          file: "packages/devtools/test/fixtures/broken-machine.mjs",
          exportNames: ["machine"]
        }],
        { root: process.cwd() }
      )

      assert.strictEqual(results.length, 1)
      assert.strictEqual(results[0]?._tag, "Failed")
      if (results[0]?._tag === "Failed") {
        assert.strictEqual(results[0].diagnostics[0]?.code, "module-load-failed")
      }
    }).pipe(Effect.provide(ProjectInspector.layer)))

  it.effect("plans dynamic resolvers from a portable isolated session", () =>
    Effect.gen(function*() {
      const inspector = yield* ProjectInspector.ProjectInspector
      const source = {
        file: "packages/devtools/src/internal/browser/example-machine.ts",
        exportName: "machine"
      }
      const started = yield* inspector.simulate({
        _tag: "StartSimulation",
        protocolVersion: DevToolsProtocol.protocolVersion,
        key: `${source.file}#${source.exportName}`,
        revision: 12,
        source
      }, { root: process.cwd() })

      assert.strictEqual(started._tag, "SimulationReady")
      if (started._tag !== "SimulationReady") return
      assert.strictEqual(started.step, 0)
      assert.deepStrictEqual(started.current.candidateEvents, ["Start", "Refresh", "Disconnect"])

      const stepped = yield* inspector.simulate({
        _tag: "SendSimulationEvent",
        protocolVersion: DevToolsProtocol.protocolVersion,
        key: started.key,
        revision: started.revision,
        source,
        step: started.step,
        snapshot: started.snapshot,
        event: { _tag: "Start" }
      }, { root: process.cwd() })

      assert.strictEqual(
        stepped._tag,
        "SimulationReady",
        stepped._tag === "SimulationFailed" ? stepped.diagnostics[0]?.message : undefined
      )
      if (stepped._tag !== "SimulationReady") return
      assert.strictEqual(stepped.step, 1)
      assert.deepStrictEqual(stepped.current.activePaths, [
        "application",
        "application.workflow",
        "application.workflow.running",
        "application.workflow.running.editing",
        "application.connection",
        "application.connection.online"
      ])
      assert.strictEqual(stepped.frame.microsteps[0]?.transitions[0]?.source, "application.workflow.idle")
      assert.deepStrictEqual(stepped.frame.microsteps[0]?.transitions[0]?.updates, ["application.workflow"])
      assert.deepStrictEqual(stepped.frame.commands, [])
      assert.deepStrictEqual(Schema.decodeUnknownSync(DevToolsProtocol.SimulationResult)(stepped), stepped)
    }).pipe(Effect.provide(ProjectInspector.layer)))

  it.effect("returns schema failures as simulation diagnostics", () =>
    Effect.gen(function*() {
      const inspector = yield* ProjectInspector.ProjectInspector
      const source = {
        file: "packages/devtools/src/internal/browser/example-machine.ts",
        exportName: "machine"
      }
      const started = yield* inspector.simulate({
        _tag: "StartSimulation",
        protocolVersion: DevToolsProtocol.protocolVersion,
        key: "example",
        revision: 0,
        source
      }, { root: process.cwd() })
      if (started._tag !== "SimulationReady") return
      const failed = yield* inspector.simulate({
        _tag: "SendSimulationEvent",
        protocolVersion: DevToolsProtocol.protocolVersion,
        key: started.key,
        revision: started.revision,
        source,
        step: started.step,
        snapshot: started.snapshot,
        event: { _tag: "UnknownEvent" }
      }, { root: process.cwd() })

      assert.strictEqual(failed._tag, "SimulationFailed")
      if (failed._tag === "SimulationFailed") {
        assert.strictEqual(failed.diagnostics[0]?.code, "simulation-planning-failed")
        assert.deepStrictEqual(failed.inputIssues, [])
      }
    }).pipe(Effect.provide(ProjectInspector.layer)))

  it.effect("returns authoritative input issues with field paths", () =>
    Effect.gen(function*() {
      const inspector = yield* ProjectInspector.ProjectInspector
      const source = {
        file: "packages/devtools/src/internal/browser/planner-example.ts",
        exportName: "plannerMachine"
      }
      const started = yield* inspector.simulate({
        _tag: "StartSimulation",
        protocolVersion: DevToolsProtocol.protocolVersion,
        key: "planner-input-validation",
        revision: 0,
        source,
        input: {
          owner: "Agent",
          attempts: 2,
          notifications: false,
          mode: "guided"
        }
      }, { root: process.cwd() })
      if (started._tag !== "SimulationReady") return

      const failed = yield* inspector.simulate({
        _tag: "SendSimulationEvent",
        protocolVersion: DevToolsProtocol.protocolVersion,
        key: started.key,
        revision: started.revision,
        source,
        step: started.step,
        snapshot: started.snapshot,
        event: {
          _tag: "Begin",
          job: "",
          priority: "unsupported",
          estimate: 101,
          approved: true
        }
      }, { root: process.cwd() })

      assert.strictEqual(failed._tag, "SimulationFailed")
      if (failed._tag !== "SimulationFailed") return
      assert.deepStrictEqual(
        failed.inputIssues.map(({ path }) => path),
        [["job"], ["priority"], ["estimate"]]
      )
    }).pipe(Effect.provide(ProjectInspector.layer)))

  it.effect("reports payload branches, raised events, emissions, commands, and output", () =>
    Effect.gen(function*() {
      const inspector = yield* ProjectInspector.ProjectInspector
      const source = {
        file: "packages/devtools/src/internal/browser/planner-example.ts",
        exportName: "plannerMachine"
      }
      const started = yield* inspector.simulate({
        _tag: "StartSimulation",
        protocolVersion: DevToolsProtocol.protocolVersion,
        key: "planner-example",
        revision: 3,
        source,
        input: {
          owner: "Agent",
          attempts: 2,
          notifications: false,
          mode: "guided"
        }
      }, { root: process.cwd() })
      assert.strictEqual(started._tag, "SimulationReady")
      if (started._tag !== "SimulationReady") return

      const planned = yield* inspector.simulate({
        _tag: "SendSimulationEvent",
        protocolVersion: DevToolsProtocol.protocolVersion,
        key: started.key,
        revision: started.revision,
        source,
        step: started.step,
        snapshot: started.snapshot,
        event: {
          _tag: "Begin",
          job: "release",
          priority: "urgent",
          estimate: 13,
          approved: true
        }
      }, { root: process.cwd() })

      assert.strictEqual(planned._tag, "SimulationReady")
      if (planned._tag !== "SimulationReady") return
      assert.deepStrictEqual(planned.current.activePaths, ["Finished"])
      assert.deepStrictEqual(planned.frame.microsteps.map((step) => (step.event as { _tag: string })._tag), [
        "Begin",
        "AutoFinish"
      ])
      assert.strictEqual(planned.frame.microsteps[0]?.transitions[0]?.branchKey, "urgent")
      assert.deepStrictEqual(planned.frame.emittedEvents, [{ _tag: "Planned", job: "release" }])
      assert.deepStrictEqual(planned.frame.commands, [{
        _tag: "SendTo",
        target: "planner-example",
        event: { _tag: "Cancel" }
      }])
      assert.strictEqual(planned.frame.done, true)
      assert.strictEqual(planned.frame.output, "release")
    }).pipe(Effect.provide(ProjectInspector.layer)))

  it.effect("retains a known candidate only while its source is syntactically incomplete", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "effect-machine-inspector-"))),
      (root) =>
        Effect.gen(function*() {
          const inspector = yield* ProjectInspector.ProjectInspector
          const sourceDirectory = join(root, "src")
          const sourceFile = join(sourceDirectory, "workflow.ts")
          yield* Effect.promise(() => mkdir(sourceDirectory))
          yield* Effect.promise(() => writeFile(sourceFile, "export const building = {", "utf8"))

          const options = {
            root,
            retainedCandidates: [{ file: "src/workflow.ts", exportNames: ["workflow"] }]
          }
          assert.deepStrictEqual(yield* inspector.discover(options), options.retainedCandidates)

          yield* Effect.promise(() => writeFile(sourceFile, "export const value = 1\n", "utf8"))
          assert.deepStrictEqual(yield* inspector.discover(options), [])
        }).pipe(Effect.provide(ProjectInspector.layer)),
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true }))
    ))
})
