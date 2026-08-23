import { assert, describe, it } from "@effect/vitest"
import { Machine } from "../../src/index.js"
import { machine, snapshot } from "../../visualizer/src/example-machine.js"
import { makeTextTreeRenderer, textTreeToString } from "../../visualizer/src/text-tree.js"
import { makeTextRenderer } from "./visualization/text.js"

const renderText = makeTextRenderer<typeof machine, typeof snapshot>(Machine)
const renderTextTree = makeTextTreeRenderer<typeof machine, typeof snapshot>(Machine)

describe("Interactive text visualization", () => {
  it("preserves the static text renderer output", () => {
    assert.strictEqual(textTreeToString(renderTextTree(machine, snapshot)), renderText(machine, snapshot))
  })
})
