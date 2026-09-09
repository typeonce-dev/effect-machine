import { strict as assert } from "node:assert"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import ts from "typescript"

const projectRoot = path.resolve(import.meta.dirname, "../packages/effect-machine")
const virtualFile = path.join(projectRoot, "invoke-autocomplete.fixture.ts")
const source = `
import { Effect, Schema, Stream } from "effect"
import { Machine } from "./src/index.js"
import { AtomMachine } from "./src/unstable/reactivity/index.js"

const rootCompletion = Machine.state({ /*root-properties*/ initial: "Idle", states: { Idle: {} } })
void rootCompletion

class AtomIdle extends Schema.TaggedClass<AtomIdle>("AtomIdle")("AtomIdle", {}) {}
class AtomReady extends Schema.TaggedClass<AtomReady>("AtomReady")("AtomReady", {}) {}
const AtomStates = Machine.state({ initial: "AtomIdle", states: { AtomIdle, AtomReady } })
const atomDefinition = Machine.make({
  root: AtomStates,
  events: Machine.eventsFromSchemas(),
  input: Schema.String,
  initialConfiguration: (root) => root.resolve(({ target }) => target.from(to => to.AtomIdle.decoded(new AtomIdle({}))))
}).handle({ states: { AtomIdle: {}, AtomReady: {} } })

AtomMachine.family(atomDefinition, {
  atoms: {
    selected: AtomMachine.select("AtomIdle"),
    snapshot: AtomMachine.selectSnapshot("AtomIdle"),
    matched: AtomMachine.matches("AtomReady")
  }
})

const atomChildDefinition = Machine.make({
  root: AtomStates,
  events: Machine.eventsFromSchemas(),
  initialConfiguration: (root) => root.resolve(({ target }) => target.from(to => to.AtomIdle.decoded(new AtomIdle({}))))
}).handle({ states: { AtomIdle: {}, AtomReady: {} } })
const AtomChild = Machine.childFamily(atomChildDefinition)
const atomParent = AtomMachine.make(Machine.make({
  root: AtomStates,
  events: Machine.eventsFromSchemas(),
  initialConfiguration: (root) => root.resolve(({ target }) => target.from(to => to.AtomIdle.decoded(new AtomIdle({}))))
}).handle({ states: { AtomIdle: {}, AtomReady: {} } }))
AtomMachine.familyChild(atomParent, {
  child: (id: string) => AtomChild(id),
  atoms: {
    childSelected: AtomMachine.selectChild("AtomIdle"),
    childMatched: AtomMachine.matchesChild("AtomReady")
  }
})
AtomMachine.familyChild(atomParent, {
  child: (id: string) => AtomChild(id),
  atoms: {
    // @ts-expect-error empty paths keep the completion position unfiltered
    childSelectedCompletion: AtomMachine.selectChild(""),
    childSnapshotCompletion: AtomMachine.selectSnapshotChild(""),
    childMatchedCompletion: AtomMachine.matchesChild("")
  }
})

const States = Machine.state({ initial: "Loading", states: { Loading: {}, Done: {}, Failed: {} } })
const targets = Machine.targets(States)
Machine.make({ /*invoke-sources*/root: States, events: Machine.eventsFromSchemas() })
const definition = Machine.make({
  effects: { load: (tag: symbol) => Effect.fail("offline").pipe(Effect.as(tag)) },
  streams: { updates: Stream.make(1) },
  branches: { complete: { ready: { target: targets./*branch-target-scopes*/root.Done }, unchanged: { none: true } } },
  root: States, events: Machine.eventsFromSchemas(),
  initialConfiguration: root => root./*initial-operations*/resolve(({ /*initial-context*/ ...context }) => context.target./*initial-exact-target*/from(to => to./*initial-selector*/Loading.from()))
})
definition.handle({ states: { Loading: { invoke: {
  src: "load", input: ({ /*invoke-source-context*/ ...context }) => context.event._tag,
  onDone: { branches: "complete", resolve: ({ /*done-context*/ ...context }) => context.select.ready./*done-exact-target*/from() },
  onFailure: { target: targets.root./*done-target*/Failed, from: ({ /*failure-context*/ ...context }) => undefined }
} } } })
definition.handle({ states: { Loading: {
// @ts-expect-error Incomplete invocation exposes required properties in completion.
invoke: {
  src: "load", input: () => Machine.InitialEventTypeId, /*invoke-properties*/
} } } })
definition.handle({ states: { Loading: { invoke: {
  src: "updates", onElement: { none: true, resolve: ({ /*element-context*/ ...context }) => undefined }, onDone: { none: true }
} } } })
const requiredParentDefinition = Machine.make({ root: States, events: Machine.eventsFromSchemas(), parent: Machine.parent(Machine.eventsFromSchemas()), effects: { wait: (_input: undefined) => Effect.never } })
requiredParentDefinition.handle({ states: { Loading: { invoke: { src: "wait", input: ({ /*required-parent-context*/ ...context }) => undefined } } } })
const optionalParentDefinition = Machine.make({ root: States, events: Machine.eventsFromSchemas(), parent: Machine.optionalParent(Machine.eventsFromSchemas()), effects: { wait: (_input: undefined) => Effect.never } })
optionalParentDefinition.handle({ states: { Loading: { invoke: { src: "wait", input: ({ /*optional-parent-context*/ ...context }) => undefined } } } })
definition.handle({ states: { Loading: {
// @ts-expect-error Incomplete transition exposes its operation fields in completion.
always: { /*transition-selector*/ }
} } })
definition.handle({ states: { Loading: { on: {}, always: { target: targets.root.Done, /*selected-operations*/ } } } })
definition.handle({ states: { Loading: { always: { none: true, resolve: ({ /*targetless-context*/ ...context }) => undefined } } } })
definition.handle({ states: { Loading: { always: { target: targets./*target-scopes*/root.Done, from: ({ /*transition-context*/ ...context }) => undefined } } } })
definition.handle({ states: { Loading: { always: { branches: "complete", resolve: ({ /*branch-resolve-context*/ ...context }) => context.select./*branch-select-keys*/ready./*transition-exact-target*/from() } } } })
definition.handle({ states: { Loading: { always: { none: true, resolve: ({ /*required-context*/ ...context }) => undefined } } } })
definition.handle({ states: { Loading: { always: { none: true, declinable: true, resolve: ({ /*declinable-context*/ ...context }) => context.decline() } } } })

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
const diagnostics = service.getSemanticDiagnostics(virtualFile)
assert.deepEqual(
  diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
  []
)

const completions = (marker) => {
  const position = source.indexOf(`/*${marker}*/`)
  assert.notEqual(position, -1)
  return new Set(service.getCompletionsAtPosition(virtualFile, position, {})?.entries.map((entry) => entry.name))
}

const stringCompletions = (prefix) => {
  const position = source.indexOf(prefix)
  assert.notEqual(position, -1)
  return new Set(service.getCompletionsAtPosition(virtualFile, position + prefix.length, {})?.entries.map((entry) => entry.name))
}

test("contextually completes data-last AtomMachine selectors", () => {
  const selected = stringCompletions('selected: AtomMachine.select("')
  assert.equal(selected.has("AtomIdle"), true)
  assert.equal(selected.has("AtomReady"), true)

  const snapshot = stringCompletions('snapshot: AtomMachine.selectSnapshot("')
  assert.equal(snapshot.has("AtomIdle"), true)
  assert.equal(snapshot.has("AtomReady"), true)

  const matched = stringCompletions('matched: AtomMachine.matches("')
  assert.equal(matched.has("AtomIdle"), true)
  assert.equal(matched.has("AtomReady"), true)

  const childSelected = stringCompletions('childSelectedCompletion: AtomMachine.selectChild("')
  assert.equal(childSelected.has("AtomIdle"), true)
  assert.equal(childSelected.has("AtomReady"), true)

  const childSnapshot = stringCompletions('childSnapshotCompletion: AtomMachine.selectSnapshotChild("')
  assert.equal(childSnapshot.has("AtomIdle"), true)
  assert.equal(childSnapshot.has("AtomReady"), true)

  const childMatched = stringCompletions('childMatchedCompletion: AtomMachine.matchesChild("')
  assert.equal(childMatched.has("AtomIdle"), true)
  assert.equal(childMatched.has("AtomReady"), true)
})

test("contextually completes Effect invocation factories while authoring", () => {
  const sources = completions("invoke-sources")
  assert.deepEqual([...sources].filter((name) => ["effects", "streams", "timers", "logic", "children"].includes(name)).sort(), [
    "children",
    "effects",
    "logic",
    "streams",
    "timers"
  ])

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
  assert.equal(done.has("select"), true)

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
  assert.equal(failure.has("target"), false)

  const properties = completions("invoke-properties")
  assert.equal(properties.has("onDone"), true)
  assert.equal(properties.has("onFailure"), true)
  assert.equal(properties.has("onElement"), false)
  assert.equal(properties.has("onSnapshot"), false)
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
  assert.equal(selector.has("full"), false)

  const scopes = completions("target-scopes")
  assert.equal(scopes.has("root"), true)
  assert.equal(scopes.has("local"), false)

  const context = completions("transition-context")
  assert.equal(context.has("state"), true)
  assert.equal(context.has("ancestors"), true)
  assert.equal(context.has("snapshot"), true)
  assert.equal(context.has("root"), true)

  const exactTarget = completions("transition-exact-target")
  assert.equal(exactTarget.has("from"), true)
  assert.equal(exactTarget.has("full"), false)
  assert.equal(exactTarget.has("Done"), false)

  const targetless = completions("targetless-context")
  assert.equal(targetless.has("state"), true)
  assert.equal(targetless.has("target"), false)

  const branchScopes = completions("branch-target-scopes")
  assert.equal(branchScopes.has("root"), true)
  assert.equal(branchScopes.has("branch"), false)

  const resolve = completions("branch-resolve-context")
  assert.equal(resolve.has("state"), true)
  assert.equal(resolve.has("select"), true)
  assert.equal(resolve.has("target"), false)

  const select = completions("branch-select-keys")
  assert.equal(select.has("ready"), true)
  assert.equal(select.has("unchanged"), true)
  assert.equal(select.has("Done"), false)

  const required = completions("required-context")
  assert.equal(required.has("decline"), true)

  const declinable = completions("declinable-context")
  assert.equal(declinable.has("decline"), true)

  const selected = completions("selected-operations")
  assert.equal(selected.has("from"), true)
  assert.equal(selected.has("decoded"), true)

})


test("completes root definition fields and topology", () => {
  const root = completions("root-properties")
  for (const key of ["fields", "schema", "type", "output", "annotations"]) {
    assert.equal(root.has(key), true, key)
  }
})
