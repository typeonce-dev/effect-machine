import { RuleTester } from "oxlint/plugins-dev"
import { describe, it } from "vitest"
import plugin from "../src/index.js"

RuleTester.describe = describe
RuleTester.it = it

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } }
})

const rule = plugin.rules["no-async-planning-callback"]

tester.run("no-async-planning-callback", rule, {
  valid: [
    `import { Machine } from "@typeonce/effect-machine"
Machine.make({ initial: (to) => to.Ready() }).handle({ Ready: { invoke: (from) => from.effect("load", async () => undefined) } })`,
    `import { Machine } from "@typeonce/effect-machine"
const other = { resolve: (_callback: unknown) => undefined }
other.resolve(async () => undefined)`,
    `import { Machine } from "@typeonce/effect-machine"
Machine.make({ initial: (to) => to.Ready(), metadata: { initial: async () => undefined } })`,
    `import { Machine } from "@typeonce/effect-machine"
const other = { handle: (_config: unknown) => undefined }
other.handle({ Ready: { entry: async () => undefined } })`,
    `const machine = { initial: async () => undefined }`
  ],
  invalid: [
    {
      code: `import { Machine } from "@typeonce/effect-machine"
Machine.make({ initial: async (to) => to.Ready() })`,
      errors: [{ messageId: "asyncPlanning" }]
    },
    {
      code: `import { Machine } from "@typeonce/effect-machine"
Machine.make({ initial: (to) => to.Ready() }).handle({ Ready: { on: { Start: async (to) => to.full.Running() } } })`,
      errors: [{ messageId: "asyncPlanning" }]
    },
    {
      code: `import { Machine } from "@typeonce/effect-machine"
Machine.make({ initial: (to) => to.Ready().resolve(async ({ target }) => target.from()) })`,
      errors: [{ messageId: "asyncPlanning" }]
    },
    {
      code: `import * as EM from "@typeonce/effect-machine"
EM.Machine.make({ initial: (to) => to.Loading() }).handle({ Loading: { invoke: (from) => from.effect("load", () => Promise.resolve()).onDone(async (to) => to.full.Done()) } })`,
      errors: [{ messageId: "asyncPlanning" }]
    },
    {
      code: `import { Machine } from "@typeonce/effect-machine"
const definition = Machine.make({ initial: (to) => to.Parent() })
definition.handle({ Parent: { states: { Child: { entry: async () => undefined } } } })`,
      errors: [{ messageId: "asyncPlanning" }]
    },
    {
      code: `import { Machine } from "@typeonce/effect-machine"
Machine.make({ initial: (to) => to.Ready() }).handle({ Ready: {
  entry: async () => undefined,
  exit: async () => undefined,
  always: async (to) => to.none,
  choice: async (to) => to.none,
  invoke: async (from) => from.timer("tick", 1)
} })`,
      errors: Array.from({ length: 5 }, () => ({ messageId: "asyncPlanning" }))
    }
  ]
})
