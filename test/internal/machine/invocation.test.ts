import { assert, describe, it } from "@effect/vitest"
import { makeChildId, makeKey } from "../../../src/internal/machine/invocation.js"

describe("machine invocation ownership", () => {
  it("keeps path and invoke id boundaries collision-free", () => {
    assert.notStrictEqual(makeKey("a", "bc"), makeKey("ab", "c"))
    assert.notStrictEqual(makeKey("root.child", "worker"), makeKey("root", ".childworker"))
  })

  it("derives stable child addresses in the invocation namespace", () => {
    assert.strictEqual(
      makeChildId("root.child", "worker"),
      "Machine.invoke:10:root.childworker"
    )
  })
})
