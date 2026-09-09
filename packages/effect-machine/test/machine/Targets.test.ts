import { assert, describe, it } from "@effect/vitest"
import { Machine } from "../../src/index.js"

describe("Machine.targets", () => {
  it("preserves state names that also look like reference metadata", () => {
    const root = Machine.state({
      initial: "root",
      states: {
        root: {
          initial: "path",
          states: { path: {}, from: {}, kind: {} }
        }
      }
    })
    const targets = Machine.targets(root)
    assert.deepStrictEqual(Object.keys(targets.root), ["root"])
    assert.deepStrictEqual(Object.keys(targets.root.root), ["path", "from", "kind"])
    assert.notStrictEqual<unknown>(targets.root.root.path, targets.root.root.from)
    assert.isTrue(Object.isFrozen(targets))
    assert.isTrue(Object.isFrozen(targets.root.root.path))
    assert.isFalse(Reflect.set(targets.root.root, "path", targets.root.root.kind))
  })

  it("keeps reused subtrees independently addressable", () => {
    const slot = Machine.state({ initial: "Idle", states: { Idle: {}, Done: {} } })
    const root = Machine.state({ initial: "Left", states: { Left: slot, Right: slot } })
    const targets = Machine.targets(root)
    assert.notStrictEqual<unknown>(targets.root.Left, targets.root.Right)
    assert.notStrictEqual<unknown>(targets.root.Left.Idle, targets.root.Right.Idle)
  })
})
