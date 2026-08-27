import { RuleTester } from "oxlint/plugins-dev"
import { describe, it } from "vitest"
import plugin from "../src/index.js"

RuleTester.describe = describe
RuleTester.it = it

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } }
})

const rule = plugin.rules["no-nondeterministic-planning"]

tester.run("no-nondeterministic-planning", rule, {
  valid: [
    `import { Machine } from "@typeonce/effect-machine"
Machine.make({ initial: (to) => to.Ready() }).handle({ Ready: { entry: ({ event }) => new Date(event.timestamp) } })`,
    `import { Machine } from "@typeonce/effect-machine"
Machine.make({ initial: (to) => to.Ready() }).handle({ Ready: { entry: ({ Date, Math }) => [Date.now(), Math.random()] } })`,
    `import { Machine } from "@typeonce/effect-machine"
Machine.make({ initial: (to) => to.Ready() }).handle({ Ready: { invoke: (from) => from.effect("random", () => crypto.randomUUID()) } })`,
    `import { Machine } from "@typeonce/effect-machine"
Machine.make({ initial: (to) => to.Ready() }).handle({ Ready: { output: ({ state }) => Date.parse(state.createdAt) } })`
  ],
  invalid: [
    {
      code: `import { Machine } from "@typeonce/effect-machine"
Machine.make({ initial: (to) => {
  Date()
  new Date()
  Date.now()
  Math.random()
  crypto.randomUUID()
  crypto.getRandomValues(new Uint8Array(1))
  performance.now()
  performance.timeOrigin
  Temporal.Now.instant()
  process.hrtime()
  process.hrtime.bigint()
  process.uptime()
  return to.Ready()
} })`,
      errors: Array.from({ length: 12 }, () => ({ messageId: "nondeterministic" }))
    },
    {
      code: `import { Machine } from "@typeonce/effect-machine"
Machine.make({ initial: (to) => to.Ready() }).handle({ Ready: {
  initialize: ({ builder }) => globalThis.Date.now() ? builder.from() : builder.from(),
  onDone: (to) => window.Math.random() ? to.none : to.none,
  history: { recent: { default: (to) => self.crypto.randomUUID() ? to.none : to.none } }
} })`,
      errors: Array.from({ length: 3 }, () => ({ messageId: "nondeterministic" }))
    }
  ]
})
