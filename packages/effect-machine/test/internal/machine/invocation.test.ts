import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { makeChildId, makeKey } from "../../../src/internal/machine/invocation.js"
import * as RuntimeProtocol from "../../../src/internal/machine/runtimeProtocol.js"

describe("machine invocation ownership", () => {
  it("keeps path and invoke id boundaries collision-free", () => {
    assert.notStrictEqual(makeKey("a", "bc"), makeKey("ab", "c"))
    assert.notStrictEqual(makeKey("root.child", "worker"), makeKey("root", ".childworker"))
  })

  it("derives stable child addresses in the invocation namespace", () => {
    assert.strictEqual(
      makeChildId("root.child", "worker"),
      "Machine.invocation:10:root.childworker"
    )
  })

  it.effect("keeps a generation current until its owner path exits", () =>
    Effect.gen(function*() {
      // Generation bookkeeping never reaches the process address or runtime.
      const owned = RuntimeProtocol.makeChildRuntimeSync(
        {} as RuntimeProtocol.ProcessAddress<unknown>,
        {} as RuntimeProtocol.ProcessRuntime
      ).owned
      const left = owned.beginGeneration("Active.left")
      const right = owned.beginGeneration("Active.right")
      assert.isTrue(left.current)
      assert.isTrue(right.current)

      // Exiting one owner path retires only that path's generation.
      yield* owned.stopPaths(["Active.left"]) ?? Effect.void
      assert.isFalse(left.current)
      assert.isTrue(right.current)

      // Entering a path again begins a distinct generation, and an entry that
      // replaces a generation directly also retires it.
      const reentered = owned.beginGeneration("Active.left")
      assert.notStrictEqual(reentered, left)
      assert.isTrue(reentered.current)
      const replaced = owned.beginGeneration("Active.left")
      assert.isFalse(reentered.current)
      assert.isTrue(replaced.current)

      yield* owned.stopAll()
      assert.isFalse(replaced.current)
      assert.isFalse(right.current)
    }))
})
