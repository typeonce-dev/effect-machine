import { assert, describe, it } from "@effect/vitest"
import { makeKey } from "../../../src/internal/machine/stepHost.js"

describe("local host of a step", () => {
  it("keeps path and invoke id boundaries collision-free", () => {
    assert.notStrictEqual(makeKey("a", "bc"), makeKey("ab", "c"))
    assert.notStrictEqual(makeKey("root.child", "worker"), makeKey("root", ".childworker"))
  })
})
