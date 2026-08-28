import { assert, describe, it } from "@effect/vitest"
import { machineIndexScrollLeft } from "../../../src/internal/browser/machine-index.js"

describe("Machine index", () => {
  it("preserves the current horizontal position when the selected machine remains visible", () => {
    assert.strictEqual(machineIndexScrollLeft(420, 640, 720, 160), 420)
  })

  it("moves only enough to reveal a selected machine outside the viewport", () => {
    assert.strictEqual(machineIndexScrollLeft(420, 640, 320, 160), 320)
    assert.strictEqual(machineIndexScrollLeft(420, 640, 1_020, 160), 540)
  })
})
