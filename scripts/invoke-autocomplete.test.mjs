import { strict as assert } from "node:assert"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import ts from "typescript"

const projectRoot = path.resolve(import.meta.dirname, "..")
const virtualFile = path.join(projectRoot, "invoke-autocomplete.fixture.ts")
const source = `
import { Effect, Option } from "effect"
import { Machine } from "./src/index.js"

const States = Machine.states({ Loading: {}, Done: {}, Failed: {} })
const definition = Machine.make({
  states: States.states,
  events: Machine.events(),
  initial: { target: (to) => to.Loading(), resolve: ({ target }) => target.from() }
})

definition.handle({
  Loading: {
    invoke: Machine.invoke({
      id: "load",
      effect: () => Effect.fail("offline").pipe(Effect.as(1)),
      onDone: Machine.transition({
        target: (to) => to.full./*done-target*/Done(),
        resolve: ({ /*done-context*/ ...context }) => context.target.from()
      }),
      onFailure: Machine.transition({
        target: (to) => to.full.Failed(),
        resolve: ({ /*failure-context*/ ...context }) => context.target.from()
      })
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
    always: Machine.transition({
      /*transition-properties*/
    })
  }
})

definition.handle({
  Loading: {
    always: Machine.transition({
      target: (to) => to.none(),
      resolve: ({ /*targetless-context*/ }) => undefined
    })
  }
})

definition.handle({
  Loading: {
    always: Machine.transition({
      target: (to) => to./*target-scopes*/full.Done(),
      resolve: ({ /*transition-context*/ ...context }) => context.target.from()
    })
  }
})

definition.handle({
  Loading: {
    always: Machine.transition({
      cases: (branch) => [branch({
        title: "ready",
        when: ({ /*case-when-context*/ }) => Option.some("ready" as const),
        target: (to) => to.full.Done(),
        resolve: ({ /*case-resolve-context*/ ...context }) => {
          const exact: "ready" = context.match
          return context.target.from()
        }
      })],
      otherwise: {
        target: (to) => to.none(),
        resolve: () => undefined
      }
    })
  }
})

definition.handle({
  Loading: {
    always: Machine.transition({
      cases: (branch) => [branch({
        /*case-properties*/
      })],
      otherwise: {
        target: (to) => to.none(),
        resolve: () => undefined
      }
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
  const done = completions("done-context")
  assert.equal(done.has("output"), true)
  assert.equal(done.has("state"), true)
  assert.equal(done.has("target"), true)

  const doneTarget = completions("done-target")
  assert.equal(doneTarget.has("Done"), true)
  assert.equal(doneTarget.has("Failed"), true)

  const failure = completions("failure-context")
  assert.equal(failure.has("error"), true)
  assert.equal(failure.has("state"), true)
  assert.equal(failure.has("target"), true)

  const properties = completions("invoke-properties")
  assert.equal(properties.has("onDone"), true)
  assert.equal(properties.has("onFailure"), true)
})

test("contextually completes transition definitions while authoring", () => {
  const properties = completions("transition-properties")
  assert.equal(properties.has("target"), true)
  assert.equal(properties.has("resolve"), true)
  assert.equal(properties.has("cases"), true)
  assert.equal(properties.has("reenter"), true)

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

  const targetless = completions("targetless-context")
  assert.equal(targetless.has("state"), true)
  assert.equal(targetless.has("target"), false)

  const when = completions("case-when-context")
  assert.equal(when.has("state"), true)
  assert.equal(when.has("target"), false)

  const resolve = completions("case-resolve-context")
  assert.equal(resolve.has("match"), true)
  assert.equal(resolve.has("target"), true)

  const caseProperties = completions("case-properties")
  assert.equal(caseProperties.has("title"), true)
  assert.equal(caseProperties.has("when"), true)
  assert.equal(caseProperties.has("target"), true)
  assert.equal(caseProperties.has("resolve"), true)

})
