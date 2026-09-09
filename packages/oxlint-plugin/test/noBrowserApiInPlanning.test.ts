import { RuleTester } from "oxlint/plugins-dev"
import { describe, it } from "vitest"
import plugin from "../src/index.js"

RuleTester.describe = describe
RuleTester.it = it

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } }
})

const rule = plugin.rules["no-browser-api-in-planning"]

tester.run("no-browser-api-in-planning", rule, {
  valid: [
    `import { Machine } from "@typeonce/effect-machine"
Machine.make({ effects: { work: input => Effect.sync(() => fetch("/api")) }, streams: { workStream: input => Stream.fromEffect(Effect.sync(() => Date.now())) } }).handle({})`,
    `import { Machine } from "@typeonce/effect-machine"
Machine.make({}).handle({ states: { Ready: { invoke: (from) => from.effect("storage", () => localStorage.getItem("key")) } } })`,
    `import { Machine } from "@typeonce/effect-machine"
Machine.make({}).handle({ states: { Ready: { entry: ({ document, navigator }) => document.read(navigator) } } })`,
    `import { Machine } from "@typeonce/effect-machine"
Machine.make({}).handle({ states: { Ready: { entry: () => {
  const url = new URL("https://example.com")
  const params = new URLSearchParams(url.search)
  return structuredClone(params)
} } } })`,
    `import { Machine } from "@typeonce/effect-machine"
Machine.make({}).handle({ root: (to) => {
  window.fetch("/api")
  window.crypto.randomUUID()
  return to.Ready()
} })`
  ],
  invalid: [
    {
      code: `import { Machine } from "@typeonce/effect-machine"
Machine.make({}).handle({ root: (to) => {
  document.querySelector("main")
  localStorage.getItem("key")
  globalThis.navigator.onLine
  matchMedia("(dark-mode)")
  new WebSocket("wss://example.com")
  void window
  void self
  return to.Ready()
} })`,
      errors: Array.from({ length: 7 }, () => ({ messageId: "browserApi" }))
    },
    {
      code: `import { Machine } from "@typeonce/effect-machine"
Machine.make({}).handle({ states: { Ready: {
  output: () => sessionStorage.length,
  history: { recent: { default: (to) => location.pathname ? to.none : to.none } }
} } })`,
      errors: Array.from({ length: 2 }, () => ({ messageId: "browserApi" }))
    }
  ]
})
