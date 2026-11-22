import { strict as assert } from "node:assert"
import path from "node:path"
import { test } from "node:test"
import ts from "typescript"

// Emits declarations for exported machines, as a library that exports one does.
// A machine's declared type depends only on its schemas and on what its handlers produce,
// so the handler config, with every handler's context, must not be printed.
const projectRoot = path.resolve(import.meta.dirname, "../packages/effect-machine")
const virtualFile = path.join(projectRoot, "machine-declarations.fixture.ts")
const source = `
import { Effect, Schema } from "effect"
import { Machine } from "./src/index.js"

const Root = Machine.state({ fields: { count: Schema.Number } })
const Events = Machine.events({ Increment: { by: Schema.Number } })
export const Counter = Machine.make({ root: Root, events: Events }).handle({
  root: () => ({ count: 0 }),
  on: {
    Increment: {
      update: { root: ({ root, event }) => ({ count: root.count + event.by }) }
    }
  }
})

const Flow = Machine.state({
  fields: { attempts: Schema.Number },
  states: {
    Idle: {},
    Editing: { fields: { draft: Schema.String } },
    Saved: { type: "final" }
  }
})
const FlowEvents = Machine.events({ Edit: { draft: Schema.String }, Save: {} })
export const Editor = Machine.make({ root: Flow, events: FlowEvents }).handle({
  root: () => ({ attempts: 0 }),
  initial: { target: "Idle" },
  states: {
    Idle: { on: { Edit: { target: "Editing", data: ({ event }) => ({ draft: event.draft }) } } },
    Editing: {
      entry: ({ state }) => {
        void state.draft
      },
      on: {
        Edit: { update: { Editing: ({ event }) => ({ draft: event.draft }) } },
        Save: { target: "Saved", guard: ({ state }) => state.draft.length > 0 }
      }
    },
    Saved: {}
  }
})
export const EditorChild = Machine.child("editor", Editor)
export const EditorChildren = Machine.childFamily(Editor)

const Fetch = Machine.state({
  states: { Loading: {}, Loaded: { fields: { value: Schema.String } } }
})
export const Loader = Machine.make({
  root: Fetch,
  events: Machine.events({}),
  effects: { load: Effect.succeed("ready") }
}).handle({
  initial: { target: "Loading" },
  states: {
    Loading: {
      invoke: {
        src: "load",
        onDone: { target: "Loaded", data: ({ output }) => ({ value: output }) }
      }
    },
    Loaded: {}
  }
})
`
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
const program = ts.createProgram([virtualFile], {
  ...parsed.options,
  rootDir: projectRoot,
  noEmit: false,
  declaration: true,
  emitDeclarationOnly: true,
  composite: false,
  incremental: false
}, host)
const sourceFile = program.getSourceFile(virtualFile)
let declarations = ""
const emitted = program.emit(sourceFile, (file, text) => {
  if (file.endsWith(".d.ts")) declarations = text
}, undefined, true)
const diagnostics = [...program.getSemanticDiagnostics(sourceFile), ...emitted.diagnostics]
const declarationFile = ts.createSourceFile("machine-declarations.fixture.d.ts", declarations, ts.ScriptTarget.Latest)
const declared = new Map(
  declarationFile.statements.filter(ts.isVariableStatement).flatMap((statement) =>
    statement.declarationList.declarations.map((declaration) => [declaration.name.getText(declarationFile), declaration.type?.getText(declarationFile) ?? ""])
  )
)

test("emits declarations for the fixture without diagnostics", () => {
  const messages = diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
  assert.deepEqual(messages, [])
})

for (const [name, prefix] of [
  ["Counter", "Machine.Machine<"],
  ["Editor", "Machine.Machine<"],
  ["EditorChild", "Machine.ChildMachine<"],
  ["EditorChildren", "Machine.ChildMachine.Family<"],
  ["Loader", "Machine.Machine<"]
]) {
  test(`declares ${name} by its schemas and outcomes, without the handler config`, () => {
    const type = declared.get(name)
    assert.ok(type?.startsWith(prefix), `expected ${name} to be declared as ${prefix}…>, got:\n${type?.slice(0, 300)}`)
    // Handlers and their context parameters are functions; a machine's schemas and outcomes are not.
    assert.ok(!type.includes("=>"), `expected no handler in the declaration of ${name}:\n${type.slice(0, 1200)}`)
  })
}

test("keeps the README counter's declaration small", () => {
  // The counter's declaration is about 550 bytes; printing its handler config tripled it.
  const bytes = Buffer.byteLength(declared.get("Counter") ?? "")
  assert.ok(bytes > 0 && bytes < 1000, `expected the Counter declaration to stay under 1000 bytes, got ${bytes}`)
})
