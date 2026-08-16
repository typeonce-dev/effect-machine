import { strict as assert } from "node:assert"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import ts from "typescript"

const projectRoot = path.resolve(import.meta.dirname, "..")
const virtualFile = path.join(projectRoot, "invoke-autocomplete.fixture.ts")
const source = `
import { Effect } from "effect"
import { Machine } from "./src/index.js"

const States = Machine.defineStates({ Loading: {}, Done: {}, Failed: {} })
const definition = Machine.make({
  states: States.states,
  events: Machine.events(),
  initial: () => States.initial.Loading.from()
})

definition.handle({
  Loading: {
    invoke: Machine.invoke({
      id: "load",
      effect: () => Effect.fail("offline").pipe(Effect.as(1)),
      onDone: ({ /*done-context*/ }) => States.initial.Done.from(),
      onFailure: ({ /*failure-context*/ }) => States.initial.Failed.from()
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
  const done = completions("done-context")
  assert.equal(done.has("output"), true)
  assert.equal(done.has("state"), true)
  assert.equal(done.has("target"), true)

  const failure = completions("failure-context")
  assert.equal(failure.has("error"), true)
  assert.equal(failure.has("state"), true)
  assert.equal(failure.has("target"), true)

  const properties = completions("invoke-properties")
  assert.equal(properties.has("onDone"), true)
  assert.equal(properties.has("onFailure"), true)
})
