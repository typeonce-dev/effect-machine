import { strict as assert } from "node:assert"
import path from "node:path"
import { test } from "node:test"
import ts from "typescript"

// Compiles invalid definitions and reads the whole diagnostic chain, as an agent reading `tsc` output does.
const projectRoot = path.resolve(import.meta.dirname, "../packages/effect-machine")
const virtualFile = path.join(projectRoot, "type-errors.fixture.ts")
const prelude = `
import { Effect, Schema } from "effect"
import { Machine } from "./src/index.js"
const Root = Machine.state({
  fields: { count: Schema.Number },
  states: {
    Editing: { fields: { complete: Schema.Boolean } },
    Checkout: {
      fields: { total: Schema.Number },
      states: {
        Charging: { fields: { amount: Schema.Number } },
        Route: { type: "choice" },
        Paid: {},
        recent: { type: "history" }
      }
    },
    Archived: { type: "final" }
  }
})
const Events = Machine.events({ Pay: { amount: Schema.Number } })
const def = Machine.make({ root: Root, events: Events, effects: { load: Effect.succeed(1) } })
const bare = Machine.make({ root: Root, events: Events })
const base = { root: { count: 0 }, initial: { target: "Editing", data: { complete: false } } } as const
`
const cases = {
  "a misspelled target": [
    `def.handle({ ...base, states: { Editing: { on: { Pay: { target: "Archivd" } } } } })`,
    `Unknown target "Archivd". Declared: `
  ],
  "a misspelled target in branches": [
    `def.handle({ ...base, states: { Editing: { on: { Pay: { branches: [{ target: "Archivd" }], resolve: ({ select }) => select.stay() } } } } })`,
    `Unknown target "Archivd". Declared:`
  ],
  "the root as a target": [
    `def.handle({ ...base, states: { Editing: { on: { Pay: { target: "root" } } } } })`,
    `Cannot target "root". Reconstruct it with initialize, or update it with update: { root: ... }`
  ],
  "a history state as a target": [
    `def.handle({ ...base, states: { Editing: { on: { Pay: { target: "Checkout.recent" } } } } })`,
    `"Checkout.recent" is a history state. Restore it with: { history: "Checkout.recent" }`
  ],
  "a target below an inactive valued state": [
    `def.handle({ ...base, states: { Editing: { on: { Pay: { target: "Checkout.Paid" } } } } })`,
    `Target "Checkout.Paid" enters "Checkout", which needs a value. Target that state and construct "Checkout.Paid" with states`
  ],
  "a target without its required data": [
    `def.handle({ ...base, states: { Editing: { on: { Pay: { target: "Checkout" } } } } })`,
    `Target "Checkout" requires data`
  ],
  "a misspelled source": [
    `def.handle({ ...base, states: { Editing: { invoke: { src: "loadd", onDone: { stay: true } } } } })`,
    `Unknown source. Registered: load`
  ],
  "a source when none is registered": [
    `bare.handle({ ...base, states: { Editing: { invoke: { src: "load", onDone: { stay: true } } } } })`,
    `Unknown source. Register it in make with effects, streams, timers, logic, or children`
  ],
  "a misspelled source in a list": [
    `def.handle({ ...base, states: { Editing: { invoke: [{ src: "load", onDone: { stay: true } }, { src: "loadd", id: "b", onDone: { stay: true } }] } } })`,
    `Unknown source. Registered: load`
  ],
  "an unknown owner": [
    `def.handle({ ...base, states: { Editing: { on: { Pay: { update: { Typo: { count: 1 } } } } } } })`,
    `Cannot update "Typo". Updatable here:`
  ],
  "an unknown owner in branches": [
    `def.handle({ ...base, states: { Checkout: { initial: { target: "Checkout.Charging", data: { amount: 1 } }, states: { Charging: { on: { Pay: { branches: [{ target: "Checkout.Paid", update: "Typo" }], resolve: ({ select }) => select.stay() } } } } } } })`,
    `Cannot update "Typo". Updatable here:`
  ],
  "two owners": [
    `def.handle({ ...base, on: { Pay: { update: { root: { count: 1 }, Editing: { complete: true } } } } })`,
    `update takes one owner, got: `
  ],
  "a transition on a final state": [
    `def.handle({ ...base, states: { Archived: { on: { Pay: { stay: true } } } } })`,
    `Final state "Archived" cannot declare on. A final state has no outgoing work`
  ],
  "an event handler on a choice": [
    `def.handle({ ...base, states: { Checkout: { initial: { target: "Checkout.Charging", data: { amount: 1 } }, states: { Route: { choice: { target: "Checkout.Paid" }, on: { Pay: { stay: true } } } } } } })`,
    `Choice state "Checkout.Route" cannot declare on. Declare one transition in choice`
  ],
  "a declared branch that is never selected": [
    `def.handle({ ...base, states: { Editing: { on: { Pay: { branches: [{ target: "Archived" }, { stay: true }], resolve: ({ select }) => select.stay() } } } } })`,
    `Declared branch { target: "Archived" } is never selected by resolve`
  ],
  "a selected branch that is not declared": [
    `def.handle({ ...base, states: { Editing: { on: { Pay: { branches: [{ target: "Archived" }], resolve: ({ select }) => select.stay() } } } } })`,
    `resolve selects undeclared { stay: true }. Add it to branches`
  ]
}

const names = Object.keys(cases)
const source = prelude + names.map((name, index) => `export const case${index} = ${cases[name][0]}\n`).join("")
const config = ts.readConfigFile(path.join(projectRoot, "tsconfig.json"), ts.sys.readFile)
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, projectRoot)
const host = {
  ...ts.createCompilerHost(parsed.options),
  fileExists: (file) => file === virtualFile || ts.sys.fileExists(file),
  readFile: (file) => file === virtualFile ? source : ts.sys.readFile(file),
  getSourceFile: (file, languageVersion) => {
    const text = file === virtualFile ? source : ts.sys.readFile(file)
    return text === undefined ? undefined : ts.createSourceFile(file, text, languageVersion, true)
  }
}
const program = ts.createProgram([virtualFile], { ...parsed.options, noEmit: true, composite: false, incremental: false }, host)
const unescape = (text) => text.replaceAll("\\\"", "\"")
const lines = source.split("\n")
const messagesByCase = new Map(names.map((name) => [name, []]))
for (const diagnostic of program.getSemanticDiagnostics(program.getSourceFile(virtualFile))) {
  const line = lines[diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line]
  const index = line.match(/^export const case(\d+) =/)?.[1]
  if (index !== undefined) {
    messagesByCase.get(names[Number(index)]).push(unescape(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")))
  }
}

for (const name of names) {
  test(`names the fix for ${name}`, () => {
    const messages = messagesByCase.get(name).join("\n")
    assert.ok(messages.includes(cases[name][1]), `expected "${cases[name][1]}" in:\n${messages.slice(0, 600)}`)
  })
}
