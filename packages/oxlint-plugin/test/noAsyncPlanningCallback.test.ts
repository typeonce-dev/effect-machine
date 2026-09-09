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
Machine.make({ effects: { work: input => Effect.sync(() => fetch("/api")) }, streams: { workStream: input => Stream.fromEffect(Effect.sync(() => Date.now())) } }).handle({})`,
    `import { Machine } from "@typeonce/effect-machine"
Machine.make({}).handle({ states: { Ready: { invoke: (from) => from.effect("load", async () => undefined) } } })`,
    `import { Machine } from "@typeonce/effect-machine"
const other = { resolve: (_callback: unknown) => undefined }
other.resolve(async () => undefined)`,
    `import { Machine } from "@typeonce/effect-machine"
Machine.make({}).handle({ root: (to) => to.Ready(), metadata: { initial: async () => undefined } })`,
    `import { Machine } from "@typeonce/effect-machine"
const other = { handle: (_config: unknown) => undefined }
other.handle({ states: { Ready: { entry: async () => undefined } } })`,
    `const machine = { initial: async () => undefined }`,
    `import { Machine } from "@typeonce/effect-machine"
Machine.make({}).handle({ states: { Ready: { invoke: (from) => [
  from.effect("fetch", () => fetch("/api")),
  from.timer("delay", () => setTimeout(() => undefined, 1))
] } } })`,
    `import { Machine } from "@typeonce/effect-machine"
Machine.make({}).handle({ states: { Ready: { entry: ({ fetch, setTimeout }) => {
  fetch()
  setTimeout()
} } } })`,
    `import { Machine } from "@typeonce/effect-machine"
Machine.make({}).handle({ states: { Ready: { entry: () => {
  const later = () => Promise.resolve()
  return later
} } } })`,
    `import { Machine } from "@typeonce/effect-machine"
Machine.make({}).handle({ states: { Ready: { entry: () =>
  other.resolve(async () => fetch("/helper"))
} } })`
  ],
  invalid: [
    {
      code: `import { Machine } from "@typeonce/effect-machine"
Machine.make({}).handle({ states: { Loading: { invoke: { src: "load", input: async () => 1, onDone: { none: true, resolve: async () => {} } } } } })`,
      errors: [{ messageId: "asyncPlanning" }, { messageId: "asyncPlanning" }]
    },
    {
      code: `import { Machine } from "@typeonce/effect-machine"
Machine.make({}).handle({ on: { Save: { target: destination, data: async () => ({}) } } })`,
      errors: [{ messageId: "asyncPlanning" }]
    },
    {
      code: `import { Machine } from "@typeonce/effect-machine"
Machine.make({ root: Machine.state({}) }).handle({ on: { Update: (to) => to.self.update.from(async () => ({ count: 1 })) } })`,
      errors: [{ messageId: "asyncPlanning" }]
    },
    {
      code: `import { Machine } from "@typeonce/effect-machine"
Machine.make({ root: Machine.state({}) }).handle({ on: { Update: (to) => to.none.guard(async () => true) } })`,
      errors: [{ messageId: "asyncPlanning" }]
    },
    {
      code: `import { Machine } from "@typeonce/effect-machine"
Machine.make({ root: Machine.state({}) }).handle({ root: async () => ({}) })`,
      errors: [{ messageId: "asyncPlanning" }]
    },
    {
      code: `import { Machine } from "@typeonce/effect-machine"
Machine.make({}).handle({ root: async (to) => to.Ready() })`,
      errors: [{ messageId: "asyncPlanning" }]
    },
    {
      code: `import { Machine } from "@typeonce/effect-machine"
Machine.make({}).handle({ states: { Ready: { on: { Start: async (to) => to.branch.Running() } } } })`,
      errors: [{ messageId: "asyncPlanning" }]
    },
    {
      code: `import { Machine } from "@typeonce/effect-machine"
Machine.make({}).handle({ root: (to) => to.Ready().resolve(async ({ target }) => target.from()) })`,
      errors: [{ messageId: "asyncPlanning" }]
    },
    {
      code: `import * as EM from "@typeonce/effect-machine"
EM.Machine.make({}).handle({ states: { Loading: { invoke: (from) => from.effect("load", () => Promise.resolve()).onDone(async (to) => to.branch.Done()) } } })`,
      errors: [{ messageId: "asyncPlanning" }]
    },
    {
      code: `import { Machine } from "@typeonce/effect-machine"
const definition = Machine.make({})
definition.handle({ states: { Parent: { states: { Child: { entry: async () => undefined } } } } })`,
      errors: [{ messageId: "asyncPlanning" }]
    },
    {
      code: `import { Machine } from "@typeonce/effect-machine"
Machine.make({}).handle({ states: { Ready: {
  entry: async () => undefined,
  exit: async () => undefined,
  always: async (to) => to.none,
  choice: async (to) => to.none,
  invoke: async (from) => from.timer("tick", 1)
} } })`,
      errors: Array.from({ length: 5 }, () => ({ messageId: "asyncPlanning" }))
    },
    {
      code: `import { Machine } from "@typeonce/effect-machine"
Machine.make({}).handle({ root: (to) => {
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
Machine.make({}).handle({ states: { Ready: {
  initial: { target: child, data: () => {
    globalThis["fetch"]("/initialize")
    return ({})
  } },
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
} } })`,
      errors: Array.from({ length: 4 }, () => ({ messageId: "asyncOperation" }))
    },
    {
      code: `import { Machine } from "@typeonce/effect-machine"
Machine.make({}).handle({ root: async (to) => {
  await fetch("/initial")
  return to.Ready()
} })`,
      errors: [{ messageId: "asyncPlanning" }]
    }
  ]
})
