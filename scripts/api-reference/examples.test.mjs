import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { test } from "node:test"

// These fixtures also compile under tsconfig.tests.json. Keep documentation
// examples identical to the checked consumer code rather than copying by hand.
test("Machine.can documents the compile-checked internal-event example", () => {
  const source = readFileSync(new URL("../../packages/effect-machine/src/Machine.ts", import.meta.url), "utf8")
  const declaration = source.indexOf("export const can:")
  assert.ok(declaration >= 0)
  const comment = source.slice(source.lastIndexOf("/**", declaration), declaration)
  const example = comment.match(/```ts\n([\s\S]*?)\n \* ```/)
  assert.ok(example)
  const actual = example[1].split("\n").map((line) => line.replace(/^ \* ?/, "")).join("\n")
  const expected = readFileSync(new URL("../../packages/effect-machine/test/examples/can.ts", import.meta.url), "utf8")
  assert.equal(actual.trim(), expected.trim())
})
