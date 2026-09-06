import { RuleTester } from "oxlint/plugins-dev"
import { describe, it } from "vitest"
import plugin from "../src/index.js"

RuleTester.describe = describe
RuleTester.it = it

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } }
})

const rule = plugin.rules["prefer-inline-handle"]

tester.run("prefer-inline-handle", rule, {
  valid: [
    `import { Machine } from "@typeonce/effect-machine"
export const definition = Machine.make({})
export const machine = definition.handle({ states: {} })`,
    `import { Machine } from "@typeonce/effect-machine"
const definition = Machine.make({})
export const first = definition.handle({ states: {} })
export const second = definition.handle({ states: {} })`,
    `import { Machine } from "@typeonce/effect-machine"
export const machine = Machine.make({}).handle({ states: {} })`,
    `import { Machine } from "other-package"
const definition = Machine.make({})
export const machine = definition.handle({ states: {} })`
  ],
  invalid: [
    {
      code: `import { Machine } from "@typeonce/effect-machine"
const definition = Machine.make({})
export const machine = definition.handle({ states: {} })`,
      errors: [{ messageId: "inlineHandle", line: 2, column: 6 }]
    },
    {
      code: `import { Machine as StateMachine } from "@typeonce/effect-machine"
const model = StateMachine.make({})
model.handle({ states: {} })`,
      errors: [{ messageId: "inlineHandle", line: 2, column: 6 }]
    },
    {
      code: `import * as EM from "@typeonce/effect-machine"
const model = EM.Machine.make({})
export default model.handle({ states: {} })`,
      errors: [{ messageId: "inlineHandle", line: 2, column: 6 }]
    }
  ]
})
