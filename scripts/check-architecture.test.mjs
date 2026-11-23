import { strict as assert } from "node:assert"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { afterEach, test } from "node:test"
import { checkArchitecture } from "./check-architecture.mjs"

const temporaryProjects = []

afterEach(() => {
  while (temporaryProjects.length > 0) {
    rmSync(temporaryProjects.pop(), { recursive: true, force: true })
  }
})

const makeProject = (files) => {
  const root = mkdtempSync(join(tmpdir(), "effect-machine-architecture-"))
  temporaryProjects.push(root)
  const projectFiles = {
    "package.json": JSON.stringify({ type: "module" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true
      },
      include: ["src/**/*.ts", "test/**/*.ts", "typetest/**/*.ts"]
    }),
    ...files
  }
  for (const [path, contents] of Object.entries(projectFiles)) {
    const destination = join(root, path)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, contents)
  }
  return root
}

const rules = (root) => checkArchitecture({ rootDirectory: root }).map((diagnostic) => diagnostic.rule)

test("accepts Effect-shaped modules and ignores type-only back-edges", () => {
  const root = makeProject({
    "src/index.ts": 'export * as Machine from "./Machine.js"',
    "src/Machine.ts": 'import * as internal from "./internal/machine/machine.js"\nimport type * as Model from "./internal/machine/model.js"\nexport interface Machine { readonly model: typeof Model.value }\nexport const make: () => Machine = internal.make',
    "src/internal/machine/machine.ts": 'import type { Machine } from "../../Machine.js"\nexport const make = (): Machine => ({ model: 1 })',
    "src/internal/machine/model.ts": 'import type { Machine } from "../../Machine.js"\nexport const value = 1',
    "test/machine/Machine.test.ts": 'import { Machine } from "../../src/index.js"\nvoid Machine',
    "test/internal/machine/model.test.ts": 'import { value } from "../../../src/internal/machine/model.js"\nvoid value'
  })
  assert.deepEqual(rules(root), [])
})

test("rejects public implementation bypasses and inferred internal signatures", () => {
  const root = makeProject({
    "src/Machine.ts": 'import * as internal from "./internal/machine/machine.js"\nimport { value } from "./internal/machine/model.js"\nexport const make = internal.make\nexport const model = value',
    "src/internal/machine/machine.ts": "export const make = () => 1",
    "src/internal/machine/model.ts": "export const value = 1"
  })
  assert.deepEqual(rules(root), ["ARCH002", "ARCH013"])
})

test("allows testing APIs to bind directly to their owning implementation modules", () => {
  const root = makeProject({
    "src/testing/MachineTest.ts": 'import * as Trace from "../internal/testing/machine/trace.js"\nimport * as Format from "../internal/testing/machine/format.js"\nexport const run: () => void = Trace.run\nexport const formatTrace: () => string = Format.formatTrace',
    "src/internal/testing/machine/trace.ts": "export const run = () => {}",
    "src/internal/testing/machine/format.ts": 'export const formatTrace = () => "trace"'
  })
  assert.deepEqual(rules(root), [])
})

test("keeps testing implementation signatures explicit and rejects unrelated internals", () => {
  const root = makeProject({
    "src/testing/MachineTest.ts": 'import * as Format from "../internal/testing/machine/format.js"\nimport { value } from "../internal/machine/runtime.js"\nexport const formatTrace = Format.formatTrace\nexport const unrelated: number = value',
    "src/internal/testing/machine/format.ts": 'export const formatTrace = () => "trace"',
    "src/internal/machine/runtime.ts": "export const value = 1"
  })
  assert.deepEqual(new Set(rules(root)), new Set(["ARCH002", "ARCH013"]))
})

test("rejects entrypoint leaks, black-box internal imports, barrels, and legacy filenames", () => {
  const root = makeProject({
    "src/index.ts": 'export { value } from "./internal/machine/model.js"',
    "src/internal/machine/model.ts": "export const value = 1",
    "src/internal/machine/index.ts": "export {}",
    "src/internal/machine/machinePlanner.ts": "export {}",
    "test/machine/model.test.ts": 'import { value } from "../../src/internal/machine/model.js"\nvoid value'
  })
  assert.deepEqual(rules(root), ["ARCH001", "ARCH011", "ARCH012", "ARCH008"])
})

test("rejects value back-edges and execution-layer inversions", () => {
  const root = makeProject({
    "src/Machine.ts": "export const Machine = 1",
    "src/internal/machine/planner.ts": 'import { Machine } from "../../Machine.js"\nimport { run } from "./runtime.js"\nexport const plan = Machine + run',
    "src/internal/machine/runtime.ts": 'import type { plan } from "./planner.js"\nexport const run: typeof plan = 1',
    "src/internal/testing/machine/arbitrary.ts": "export const arbitrary = 1",
    "src/consumer.ts": 'import { arbitrary } from "./internal/testing/machine/arbitrary.js"\nvoid arbitrary'
  })
  assert.deepEqual(rules(root), ["ARCH007", "ARCH003", "ARCH004", "ARCH005", "ARCH014", "ARCH006"])
})

test("rejects outward machine semantic dependencies", () => {
  const root = makeProject({
    "src/internal/machine/topology.ts": 'import { decode } from "./protocol.js"\nimport { invoke } from "./invocation.js"\nexport const topology = decode + invoke',
    "src/internal/machine/protocol.ts": "export const decode = 1",
    "src/internal/machine/invocation.ts": "export const invoke = 1"
  })
  assert.deepEqual(rules(root), ["ARCH005", "ARCH005", "ARCH014"])
})

test("enforces semantic boundaries for each runtime strategy and shared protocol", () => {
  for (const module of ["runtimeProtocol", "runtimeGeneric", "runtimeCompiled"]) {
    const root = makeProject({
      "src/internal/machine/planner.ts": `import { run } from "./${module}.js"\nexport const plan = run`,
      [`src/internal/machine/${module}.ts`]: 'import type { value } from "./process.js"\nexport const run: typeof value = 1',
      "src/internal/machine/process.ts": "export const value = 1"
    })
    assert.deepEqual(new Set(rules(root)), new Set(["ARCH004", "ARCH005", "ARCH006", "ARCH014"]))
  }
})

test("keeps host-neutral invocation modules independent of the local runtime", () => {
  for (const module of ["invocationChanges", "invocationGeneration", "invocationOutcome", "invocationResolution"]) {
    for (
      const local of [
        "childRegistry",
        "commandRuntime",
        "inspectionRuntime",
        "invocation",
        "process",
        "runtime",
        "runtimeCompiled",
        "runtimeGeneric",
        "runtimeProtocol"
      ]
    ) {
      const root = makeProject({
        [`src/internal/machine/${module}.ts`]: `import type { Local } from "./${local}.js"\nexport type Neutral = Local`,
        [`src/internal/machine/${local}.ts`]: "export type Local = 1"
      })
      assert.deepEqual(rules(root), ["ARCH014"])
    }
  }
})

const localRuntimeModules = [
  "src/LocalMachine",
  "src/internal/machine/childRegistry",
  "src/internal/machine/commandRuntime",
  "src/internal/machine/inspectionRuntime",
  "src/internal/machine/invocation",
  "src/internal/machine/process",
  "src/internal/machine/runtime",
  "src/internal/machine/runtimeCompiled",
  "src/internal/machine/runtimeGeneric",
  "src/internal/machine/runtimeProtocol"
]

const relativeModule = (from, to) => {
  const path = relative(dirname(from), to)
  return path.startsWith(".") ? path : `./${path}`
}

test("keeps the model and the Cluster host independent of every local runtime module", () => {
  const sources = [
    "src/Machine",
    "src/internal/machine/machine",
    "src/internal/machine/planner",
    "src/internal/machine/configuration",
    "src/internal/machine/topology",
    "src/internal/machine/serialization",
    "src/internal/machine/protocol",
    "src/internal/machine/executionPlan",
    "src/internal/machine/addedLater",
    "src/unstable/cluster/ClusterMachine",
    "src/internal/machine/cluster",
    "src/internal/machine/clusterAddedLater"
  ]
  const root = makeProject({
    ...Object.fromEntries(localRuntimeModules.map((local) => [`${local}.ts`, "export type Local = 1"])),
    ...Object.fromEntries(sources.map((source) => [
      `${source}.ts`,
      localRuntimeModules.map((local, index) =>
        `import type { Local as Local${index} } from "${relativeModule(source, local)}.js"\nexport type Independent${index} = Local${index}`
      ).join("\n")
    ]))
  })
  const reported = checkArchitecture({ rootDirectory: root }).filter((diagnostic) => diagnostic.rule === "ARCH014")
  assert.deepEqual(
    new Set(reported.map(({ message, path }) => `${path} ${message.split(" through ")[1]}`)),
    new Set(sources.flatMap((source) => localRuntimeModules.map((local) => `${source}.ts ${local}.ts`)))
  )
})

test("counts import types as type-only dependencies", () => {
  const root = makeProject({
    "src/internal/machine/planner.ts": 'export type Plan = import("./process.js").Local',
    "src/internal/machine/process.ts": "export type Local = 1"
  })
  assert.deepEqual(rules(root), ["ARCH005", "ARCH014"])
})

test("reports a dependency of the model on the local runtime once, where it enters", () => {
  const messages = (root) =>
    checkArchitecture({ rootDirectory: root }).map(({ message, path, rule }) => ({ message, path, rule }))

  const throughAnotherModule = makeProject({
    "src/internal/machine/invocationResolution.ts": 'import { helper } from "../helper.js"\nexport const resolve = helper',
    "src/internal/helper.ts": 'export { local as helper } from "./machine/process.js"',
    "src/internal/machine/process.ts": "export const local = 1"
  })
  assert.deepEqual(messages(throughAnotherModule), [{
    rule: "ARCH014",
    path: "src/internal/machine/invocationResolution.ts",
    message: "Host-neutral module depends on the local runtime through " +
      "src/internal/helper.ts -> src/internal/machine/process.ts"
  }])

  const throughAnotherHost = makeProject({
    "src/Machine.ts": 'import type { Bridge } from "./unstable/reactivity/AtomMachine.js"\nexport interface Machine { readonly bridge: Bridge }',
    "src/unstable/reactivity/AtomMachine.ts": 'export type { Bridge } from "../../internal/machine/atom.js"',
    "src/internal/machine/atom.ts": 'import type { Local } from "./process.js"\nexport type Bridge = Local',
    "src/internal/machine/process.ts": "export type Local = 1"
  })
  assert.deepEqual(messages(throughAnotherHost), [{
    rule: "ARCH014",
    path: "src/Machine.ts",
    message: "Model module depends on the local runtime through src/unstable/reactivity/AtomMachine.ts -> " +
      "src/internal/machine/atom.ts -> src/internal/machine/process.ts"
  }])

  const throughTheModel = makeProject({
    "src/Machine.ts": 'import * as internal from "./internal/machine/machine.js"\nexport interface Machine {}\nexport const make: () => Machine = internal.make',
    "src/internal/machine/machine.ts": 'export { make } from "./process.js"',
    "src/internal/machine/process.ts": "export const make = () => ({})",
    "src/internal/machine/planner.ts": 'import type { Machine } from "../../Machine.js"\nexport type Plan = (machine: Machine) => void',
    "src/internal/machine/clusterInstance.ts": 'import type { Machine } from "../../Machine.js"\nexport type Make = (machine: Machine) => void'
  })
  assert.deepEqual(messages(throughTheModel), [{
    rule: "ARCH014",
    path: "src/internal/machine/machine.ts",
    message: "Model module depends on the local runtime through src/internal/machine/process.ts"
  }])
})

test("lets the local host and the Atom host depend on the local runtime and the model", () => {
  const root = makeProject({
    "src/Machine.ts": "export interface Machine {}",
    "src/LocalMachine.ts": 'import * as internal from "./internal/machine/process.js"\nimport type { Machine } from "./Machine.js"\nexport const start: (machine: Machine) => void = internal.start',
    "src/internal/machine/process.ts": 'import type { Machine } from "../../Machine.js"\nexport const start = (_machine: Machine) => {}',
    "src/internal/machine/atom.ts": 'import type * as LocalMachine from "../../LocalMachine.js"\nimport { start } from "./process.js"\nexport const make: typeof LocalMachine.start = start',
    "src/unstable/reactivity/AtomMachine.ts": 'import * as internal from "../../internal/machine/atom.js"\nimport type * as LocalMachine from "../../LocalMachine.js"\nexport const make: typeof LocalMachine.start = internal.make'
  })
  assert.deepEqual(rules(root), [])
})

test("keeps the public local host behind its implementation seam", () => {
  const root = makeProject({
    "src/LocalMachine.ts": 'import * as internal from "./internal/machine/process.js"\nimport { run } from "./internal/machine/runtime.js"\nexport const start = internal.start\nexport const direct: number = run',
    "src/internal/machine/process.ts": 'import { direct } from "../../LocalMachine.js"\nexport const start = () => direct',
    "src/internal/machine/runtime.ts": "export const run = 1"
  })
  assert.deepEqual(new Set(rules(root)), new Set(["ARCH002", "ARCH003", "ARCH009", "ARCH013"]))
})

test("keeps the halves split out of the invocation host outside inner layers", () => {
  const root = makeProject({
    "src/internal/machine/planner.ts": 'import type { Outcome } from "./invocationOutcome.js"\nexport type Planned = Outcome',
    "src/internal/machine/runtimeProtocol.ts": 'import type { Outcome } from "./invocationOutcome.js"\nimport type { Generations } from "./invocationGeneration.js"\nexport type Runtime = [Outcome, Generations]',
    "src/internal/machine/invocationOutcome.ts": "export type Outcome = 1",
    "src/internal/machine/invocationGeneration.ts": "export type Generations = 1"
  })
  assert.deepEqual(rules(root), ["ARCH005", "ARCH006"])
})

test("detects runtime cycles while permitting type-only cycles", () => {
  const cyclic = makeProject({
    "src/a.ts": 'import { b } from "./b.js"\nexport const a = b',
    "src/b.ts": 'import { a } from "./a.js"\nexport const b = a'
  })
  assert.deepEqual(rules(cyclic), ["ARCH009"])

  const typeOnly = makeProject({
    "src/a.ts": 'import type { B } from "./b.js"\nexport interface A { readonly b: B }',
    "src/b.ts": 'import type { A } from "./a.js"\nexport interface B { readonly a: A }'
  })
  assert.deepEqual(rules(typeOnly), [])
})

test("includes re-exports and dynamic imports in the runtime graph", () => {
  const root = makeProject({
    "src/a.ts": 'export { b } from "./b.js"',
    "src/b.ts": 'export const b = import("./a.js")'
  })
  assert.deepEqual(rules(root), ["ARCH009"])
})
