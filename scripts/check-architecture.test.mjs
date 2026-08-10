import { strict as assert } from "node:assert"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
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
  assert.deepEqual(rules(root), ["ARCH007", "ARCH003", "ARCH004", "ARCH006"])
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
