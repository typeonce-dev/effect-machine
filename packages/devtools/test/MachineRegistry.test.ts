import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import * as DevToolsProtocol from "../src/DevToolsProtocol.js"
import { machine } from "../src/internal/browser/example-machine.js"
import { reconcile } from "../src/internal/machineRegistry.js"
import * as MachineDocument from "../src/MachineDocument.js"
import * as Registry from "../src/MachineRegistry.js"
import * as Inspector from "../src/ProjectInspector.js"

describe("MachineRegistry", () => {
  it.effect("serializes overlapping refreshes and increments each revision", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const revisions: Array<number | undefined> = []
      const inspector = Inspector.ProjectInspector.of({
        discover: () => Effect.succeed([]),
        evaluate: () => Effect.succeed([]),
        inspect: (options) =>
          Effect.gen(function*() {
            revisions.push(options.revision)
            if (revisions.length === 2) {
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(release)
            }
            return []
          })
      })
      yield* Effect.gen(function*() {
        const registry = yield* Registry.MachineRegistry
        const first = yield* Effect.forkScoped(registry.refresh)
        yield* Deferred.await(started)
        const second = yield* Effect.forkScoped(registry.refresh, { startImmediately: true })
        assert.deepStrictEqual(revisions, [1, 2])
        yield* Deferred.succeed(release, undefined)
        assert.strictEqual((yield* Fiber.join(first)).revision, 2)
        assert.strictEqual((yield* Fiber.join(second)).revision, 3)
        assert.strictEqual((yield* registry.get).revision, 3)
      }).pipe(
        Effect.provide(Registry.layer({ root: "." })),
        Effect.provideService(Inspector.ProjectInspector, inspector),
        Effect.scoped
      )
    }))

  it("keeps the last valid document when a reload fails", () => {
    const document = MachineDocument.make(machine, {
      source: { file: "src/workflow.ts", exportName: "workflow" }
    })
    const ready: DevToolsProtocol.Ready = {
      _tag: "Ready",
      protocolVersion: 2,
      key: "src/workflow.ts#workflow",
      document,
      diagnostics: []
    }
    const failed: DevToolsProtocol.Failed = {
      _tag: "Failed",
      protocolVersion: 2,
      key: ready.key,
      source: { file: "src/workflow.ts", exportName: "workflow" },
      machineId: null,
      diagnostics: [{
        severity: "error",
        code: "module-load-failed",
        message: "Unexpected end of input",
        location: { file: "src/workflow.ts", line: null, column: null },
        statePath: null
      }]
    }

    const result = reconcile([ready], [failed])[0]
    assert.strictEqual(result?._tag, "Partial")
    if (result?._tag === "Partial") {
      assert.strictEqual(result.document, document)
      assert.deepStrictEqual(result.diagnostics.map((diagnostic) => diagnostic.code), [
        "stale-document",
        "module-load-failed"
      ])
    }
  })

  it("matches a failed reload by source file when its export identity changes", () => {
    const document = MachineDocument.make(machine, {
      source: { file: "src/workflow.ts", exportName: "workflow" }
    })
    const ready: DevToolsProtocol.Ready = {
      _tag: "Ready",
      protocolVersion: 2,
      key: "src/workflow.ts#workflow",
      document,
      diagnostics: []
    }
    const failed: DevToolsProtocol.Failed = {
      _tag: "Failed",
      protocolVersion: 2,
      key: "src/workflow.ts#renamed",
      source: { file: "src/workflow.ts", exportName: "renamed" },
      machineId: null,
      diagnostics: [{
        severity: "error",
        code: "module-load-failed",
        message: "Unexpected end of input",
        location: { file: "src/workflow.ts", line: null, column: null },
        statePath: null
      }]
    }

    const result = reconcile([ready], [failed])[0]
    assert.strictEqual(result?._tag, "Partial")
    assert.strictEqual(result?.key, ready.key)
  })
})
