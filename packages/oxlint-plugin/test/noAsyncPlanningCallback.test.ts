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
    `const machine = { initial: async () => undefined }`,
    `import { Machine } from "@typeonce/effect-machine"
Machine.make({ initial: (to) => to.Ready() }).handle({ Ready: { invoke: (from) => [
  from.effect("fetch", () => fetch("/api")),
  from.timer("delay", () => setTimeout(() => undefined, 1))
] } })`,
    `import { Machine } from "@typeonce/effect-machine"
Machine.make({ initial: (to) => to.Ready() }).handle({ Ready: { entry: ({ fetch, setTimeout }) => {
  fetch()
  setTimeout()
} } })`,
    `import { Machine } from "@typeonce/effect-machine"
Machine.make({ initial: (to) => to.Ready() }).handle({ Ready: { entry: () => {
  const later = () => Promise.resolve()
  return later
} } })`,
    `import { Machine } from "@typeonce/effect-machine"
Machine.make({ initial: (to) => to.Ready() }).handle({ Ready: { entry: () =>
  other.resolve(async () => fetch("/helper"))
} })`
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
    },
    {
      code: `import { Machine } from "@typeonce/effect-machine"
Machine.make({ initial: (to) => {
  fetch("/initial")
  new Promise(() => undefined)
  Promise.all([])
  setTimeout(() => undefined, 1)
  queueMicrotask(() => undefined)
  process.nextTick(() => undefined)
  return to.Ready()
} })`,
      errors: Array.from({ length: 6 }, () => ({ messageId: "asyncOperation" }))
    },
    {
      code: `import { Machine } from "@typeonce/effect-machine"
Machine.make({ initial: (to) => to.Ready() }).handle({ Ready: {
  initialize: ({ builder }) => {
    globalThis["fetch"]("/initialize")
    return builder.from()
  },
  output: ({ state }) => {
    window.setInterval(() => undefined, 100)
    return state
  },
  onDone: (to) => {
    self.requestAnimationFrame(() => undefined)
    return to.none
  },
  history: { recent: { default: (to) => {
    requestIdleCallback(() => undefined)
    return to.none
  } } }
} })`,
      errors: Array.from({ length: 4 }, () => ({ messageId: "asyncOperation" }))
    },
    {
      code: `import { Machine } from "@typeonce/effect-machine"
Machine.make({ initial: async (to) => {
  await fetch("/initial")
  return to.Ready()
} })`,
      errors: [{ messageId: "asyncPlanning" }]
    }
  ]
})
