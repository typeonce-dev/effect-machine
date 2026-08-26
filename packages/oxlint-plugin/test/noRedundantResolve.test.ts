import { RuleTester } from "oxlint/plugins-dev"
import { describe, it } from "vitest"
import plugin from "../src/index.js"

RuleTester.describe = describe
RuleTester.it = it

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } }
})

const rule = plugin.rules["no-redundant-resolve"]

tester.run("no-redundant-resolve", rule, {
  valid: [
    `import { Machine } from "@typeonce/effect-machine"
Machine.make({ initial: (to) => to.Ready().resolve(({ target }) => target.from({ id: "ready" })) })`,
    `import { Machine } from "@typeonce/effect-machine"
Machine.make({ initial: (to) => to.Ready().resolve(({ target }) => target.from(), { reenter: true }) })`,
    `import { Machine } from "@typeonce/effect-machine"
const other = { resolve: (_callback: unknown) => undefined }
other.resolve(({ target }) => target.from())`,
    `import { Machine } from "@typeonce/effect-machine"
Machine.make({ initial: (to) => to.Ready() }).handle({ Ready: { invoke: (from) => from.effect("work", () => other.resolve(({ target }) => target.from())) } })`,
    `const other = { resolve: (_callback: unknown) => undefined }
other.resolve(({ target }) => target.from())`
  ],
  invalid: [
    {
      code: `import { Machine } from "@typeonce/effect-machine"
Machine.make({ initial: (to) => to.Ready().resolve(({ target }) => target.from()) })`,
      output: `import { Machine } from "@typeonce/effect-machine"
Machine.make({ initial: (to) => to.Ready() })`,
      errors: [{ messageId: "redundantResolver" }]
    },
    {
      code: `import { Machine } from "@typeonce/effect-machine"
const definition = Machine.make({ initial: (to) => to.Ready() })
definition.handle({ Ready: { on: { Reset: (to) => to.full.Ready().resolve(({ target }) => target.from()) } } })`,
      output: `import { Machine } from "@typeonce/effect-machine"
const definition = Machine.make({ initial: (to) => to.Ready() })
definition.handle({ Ready: { on: { Reset: (to) => to.full.Ready() } } })`,
      errors: [{ messageId: "redundantResolver" }]
    },
    {
      code: `import { Machine as StateMachine } from "@typeonce/effect-machine"
StateMachine.make({ initial: (to) => to.Ready().resolve(({ target: next }) => { return next.from() }) })`,
      output: `import { Machine as StateMachine } from "@typeonce/effect-machine"
StateMachine.make({ initial: (to) => to.Ready() })`,
      errors: [{ messageId: "redundantResolver" }]
    },
    {
      code: `import * as EM from "@typeonce/effect-machine"
EM.Machine.make({ initial: (to) => to.Ready().resolve(({ target }) => /* preserve */ target.from()) })`,
      output: null,
      errors: [{ messageId: "redundantResolver" }]
    }
  ]
})
