import { strict as assert } from "node:assert"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import ts from "typescript"

const projectRoot = path.resolve(import.meta.dirname, "..")
const virtualFile = path.join(projectRoot, "invoke-autocomplete.fixture.ts")
const source = `
import { Effect, Stream } from "effect"
import { Machine } from "./src/index.js"

const States = Machine.states({ Loading: {}, Done: {}, Failed: {} })
const definition = Machine.make({
  states: States.states,
  events: Machine.events(),
  initial: (to) =>
    to./*initial-selector*/Loading()./*initial-operations*/resolve(({ /*initial-context*/ ...context }) =>
      context.target./*initial-exact-target*/from())
})

definition.handle({
  Loading: {
    invoke: Machine.invoke({
      id: "load",
      effect: ({ /*invoke-source-context*/ ...context }) =>
        Effect.fail("offline").pipe(Effect.as(context.state._tag)),
      onDone: (to) =>
        to.full./*done-target*/Done()./*selected-operations*/resolve(({ /*done-context*/ ...context }) =>
          context.target./*done-exact-target*/from()),
      onFailure: (to) =>
        to.full.Failed().resolve(({ /*failure-context*/ ...context }) =>
          context.target.from())
    })
  },
  Done: {},
  Failed: {}
})

const requiredParentDefinition = Machine.make({
  states: States.states,
  events: Machine.events(),
  parent: Machine.parent(Machine.events()),
  initial: (to) => to.Loading()
})

requiredParentDefinition.handle({
  Loading: {
    invoke: Machine.invoke({
      id: "required-parent",
      effect: ({ /*required-parent-context*/ ...context }) => Effect.never
    })
  },
  Done: {},
  Failed: {}
})

const optionalParentDefinition = Machine.make({
  states: States.states,
  events: Machine.events(),
  parent: Machine.optionalParent(Machine.events()),
  initial: (to) => to.Loading()
})

optionalParentDefinition.handle({
  Loading: {
    invoke: Machine.invoke({
      id: "optional-parent",
      effect: ({ /*optional-parent-context*/ ...context }) => Effect.never
    })
  },
  Done: {},
  Failed: {}
})

definition.handle({
  Loading: {
    invoke: Machine.invoke({
      id: "updates",
      stream: () => Stream.make(1),
      onElement: (to) =>
        to.none.resolve(({ /*element-context*/ ...context }) => undefined),
      onDone: (to) => to.none
    })
  },
  Done: {},
  Failed: {}
})

definition.handle({
  Loading: {
    invoke: Machine.invoke({
      id: "incomplete",
      effect: () => Effect.fail("offline").pipe(Effect.as(1)),
      /*invoke-properties*/
    })
  },
  Done: {},
  Failed: {}
})

definition.handle({
  Loading: {
    always: (to) => to./*transition-selector*/none
  }
})

definition.handle({
  Loading: {
    always: (to) =>
      to.none.resolve(({ /*targetless-context*/ ...context }) => undefined)
  }
})

definition.handle({
  Loading: {
    always: (to) =>
      to./*target-scopes*/full.Done().resolve(({ /*transition-context*/ ...context }) =>
        context.target./*transition-exact-target*/from())
  }
})

definition.handle({
  Loading: {
    always: (to) =>
      to.branches({
        ready: {
          title: "ready",
          target: to./*branch-target-scopes*/full.Done()
        },
        unchanged: { target: to.none }
      }).resolve(({ /*branch-resolve-context*/ ...context }) =>
        context.select./*branch-select-keys*/ready.from())
  }
})

definition.handle({
  Loading: {
    always: (to) =>
      to.none.resolve(({ /*required-context*/ ...context }) => undefined)
  }
})

definition.handle({
  Loading: {
    always: (to) =>
      to.none.resolve(({ /*declinable-context*/ ...context }) => context.decline(), {
        declinable: true
      })
  }
})

`

const config = ts.readConfigFile(path.join(projectRoot, "tsconfig.json"), ts.sys.readFile)
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, projectRoot)
const host = {
  directoryExists: ts.sys.directoryExists,
  fileExists: ts.sys.fileExists,
  getCompilationSettings: () => parsed.options,
  getCurrentDirectory: () => projectRoot,
  getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
  getDirectories: ts.sys.getDirectories,
  getNewLine: () => ts.sys.newLine,
  getScriptFileNames: () => [...parsed.fileNames, virtualFile],
  getScriptSnapshot: (file) =>
    file === virtualFile
      ? ts.ScriptSnapshot.fromString(source)
      : fs.existsSync(file)
      ? ts.ScriptSnapshot.fromString(fs.readFileSync(file, "utf8"))
      : undefined,
  getScriptVersion: () => "0",
  readDirectory: ts.sys.readDirectory,
  readFile: ts.sys.readFile,
  realpath: ts.sys.realpath,
  useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames
}

const service = ts.createLanguageService(host)

const completions = (marker) => {
  const position = source.indexOf(`/*${marker}*/`)
  assert.notEqual(position, -1)
  return new Set(service.getCompletionsAtPosition(virtualFile, position, {})?.entries.map((entry) => entry.name))
}

test("contextually completes Effect invocation factories while authoring", () => {
  const sourceContext = completions("invoke-source-context")
  assert.equal(sourceContext.has("state"), true)
  assert.equal(sourceContext.has("ancestors"), true)
  assert.equal(sourceContext.has("event"), true)
  assert.equal(sourceContext.has("snapshot"), false)
  assert.equal(sourceContext.has("self"), true)
  assert.equal(sourceContext.has("parent"), false)

  assert.equal(completions("required-parent-context").has("parent"), true)
  assert.equal(completions("optional-parent-context").has("parent"), true)

  const done = completions("done-context")
  assert.equal(done.has("output"), true)
  assert.equal(done.has("state"), true)
  assert.equal(done.has("target"), true)

  const doneTarget = completions("done-target")
  assert.equal(doneTarget.has("Done"), true)
  assert.equal(doneTarget.has("Failed"), true)

  const exactTarget = completions("done-exact-target")
  assert.equal(exactTarget.has("from"), true)
  assert.equal(exactTarget.has("full"), false)
  assert.equal(exactTarget.has("Done"), false)

  const failure = completions("failure-context")
  assert.equal(failure.has("error"), true)
  assert.equal(failure.has("state"), true)
  assert.equal(failure.has("target"), true)

  const properties = completions("invoke-properties")
  assert.equal(properties.has("onDone"), true)
  assert.equal(properties.has("onFailure"), true)
})

test("contextually completes Stream element handlers while authoring", () => {
  const element = completions("element-context")
  assert.equal(element.has("element"), true)
  assert.equal(element.has("state"), true)
  assert.equal(element.has("target"), false)
})

test("contextually completes transition definitions while authoring", () => {
  const initialSelector = completions("initial-selector")
  assert.equal(initialSelector.has("Loading"), true)
  assert.equal(initialSelector.has("none"), false)

  const initialOperations = completions("initial-operations")
  assert.equal(initialOperations.has("resolve"), true)
  assert.equal(initialOperations.has("reenter"), false)

  const initialContext = completions("initial-context")
  assert.equal(initialContext.has("input"), true)
  assert.equal(initialContext.has("target"), true)

  const initialTarget = completions("initial-exact-target")
  assert.equal(initialTarget.has("from"), true)
  assert.equal(initialTarget.has("Done"), false)

  const selector = completions("transition-selector")
  assert.equal(selector.has("none"), true)
  assert.equal(selector.has("branches"), true)
  assert.equal(selector.has("full"), true)

  const scopes = completions("target-scopes")
  assert.equal(scopes.has("none"), true)
  assert.equal(scopes.has("local"), true)
  assert.equal(scopes.has("branch"), true)
  assert.equal(scopes.has("full"), true)
  assert.equal(scopes.has("history"), true)

  const context = completions("transition-context")
  assert.equal(context.has("state"), true)
  assert.equal(context.has("ancestors"), true)
  assert.equal(context.has("snapshot"), true)
  assert.equal(context.has("target"), true)

  const exactTarget = completions("transition-exact-target")
  assert.equal(exactTarget.has("from"), true)
  assert.equal(exactTarget.has("full"), false)
  assert.equal(exactTarget.has("Done"), false)

  const targetless = completions("targetless-context")
  assert.equal(targetless.has("state"), true)
  assert.equal(targetless.has("target"), false)

  const branchScopes = completions("branch-target-scopes")
  assert.equal(branchScopes.has("none"), true)
  assert.equal(branchScopes.has("local"), true)
  assert.equal(branchScopes.has("branch"), true)
  assert.equal(branchScopes.has("full"), true)
  assert.equal(branchScopes.has("history"), true)

  const resolve = completions("branch-resolve-context")
  assert.equal(resolve.has("state"), true)
  assert.equal(resolve.has("select"), true)
  assert.equal(resolve.has("target"), false)

  const select = completions("branch-select-keys")
  assert.equal(select.has("ready"), true)
  assert.equal(select.has("unchanged"), true)
  assert.equal(select.has("Done"), false)

  const required = completions("required-context")
  assert.equal(required.has("decline"), false)

  const declinable = completions("declinable-context")
  assert.equal(declinable.has("decline"), true)

  const selected = completions("selected-operations")
  assert.equal(selected.has("resolve"), true)
  assert.equal(selected.has("reenter"), true)

})
