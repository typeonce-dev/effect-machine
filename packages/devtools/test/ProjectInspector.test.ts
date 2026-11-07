import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as CheckCommand from "../src/internal/checkCommand.js"
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

  it.effect("checks exported machines in the isolated worker and reports problems as data", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "effect-machine-check-"))),
      (root) =>
        Effect.gen(function*() {
          yield* Effect.promise(() => mkdir(join(root, "src"), { recursive: true }))
          yield* Effect.promise(() =>
            writeFile(
              join(root, "src", "orphan.mjs"),
              `import { Machine } from "@typeonce/effect-machine"
export const orphan = Machine.make({
  id: "orphan",
  root: Machine.state({ states: { Idle: {}, Lost: {} } }),
  events: Machine.events({ Go: {} })
}).handle({ initial: { target: "Idle" }, states: { Idle: { on: { Go: { target: "Idle" } } } } })
`
            )
          )
          const results = yield* ProjectInspector.check({ root, include: "src/*.mjs" })
          const failed = results[0]
          // A temporary project cannot resolve the package, so this asserts the failure path.
          assert.strictEqual(failed?._tag, "Failed")

          const checked = yield* ProjectInspector.check({
            root: process.cwd(),
            include: "packages/devtools/src/internal/browser/example-machine.ts"
          })
          assert.strictEqual(checked.length, 1)
          const result = checked[0]
          assert.strictEqual(result?._tag, "Checked")
          if (result?._tag === "Checked") {
            const report = result.report as { readonly machine: string; readonly text: string }
            assert.strictEqual(report.machine, "inspection-example")
            assert.include(report.text, "inspection-example")
            assert.isTrue(CheckCommand.renderJson(checked).includes("\"schemaVersion\": 1"))
          }
        }).pipe(Effect.provide(ProjectInspector.layer)),
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true }))
    ))

  it("treats a project with nothing to check as a failure", () => {
    assert.isFalse(CheckCommand.isOk([]))
    assert.strictEqual(CheckCommand.renderText([]), "No Effect Machine definitions found")
  })

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
