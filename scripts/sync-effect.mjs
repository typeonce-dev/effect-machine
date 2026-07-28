#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { resolve, dirname } from "node:path"

const root = resolve(import.meta.dirname, "..")
const args = process.argv.slice(2)
const check = args.includes("--check")
const directoryArg = args.find((arg) => !arg.startsWith("--"))
const effectRoot = resolve(directoryArg ?? process.env.EFFECT_CHECKOUT ?? "../effect")

const files = [
  ["src/Machine.ts", "packages/effect/src/unstable/machine/Machine.ts", "machine"],
  ["src/internal/machineErrors.ts", "packages/effect/src/unstable/machine/internal/machineErrors.ts", "internal"],
  ["src/internal/machineModel.ts", "packages/effect/src/unstable/machine/internal/machineModel.ts", "internal"],
  ["src/internal/machinePlanner.ts", "packages/effect/src/unstable/machine/internal/machinePlanner.ts", "internal"],
  ["src/internal/machineProcess.ts", "packages/effect/src/unstable/machine/internal/machineProcess.ts", "internal"],
  ["src/internal/machineRuntime.ts", "packages/effect/src/unstable/machine/internal/machineRuntime.ts", "internal"],
  ["src/AtomMachine.ts", "packages/effect/src/unstable/reactivity/AtomMachine.ts", "atom"],
  ["src/ClusterMachine.ts", "packages/effect/src/unstable/cluster/ClusterMachine.ts", "cluster"],
  ["test/Machine.test.ts", "packages/effect/test/unstable/machine/Machine.test.ts", "machine-test"],
  ["test/AtomMachine.test.ts", "packages/effect/test/reactivity/AtomMachine.test.ts", "atom-test"],
  ["test/ClusterMachine.test.ts", "packages/effect/test/cluster/ClusterMachine.test.ts", "cluster-test"],
  ["typetest/Machine.tst.ts", "packages/effect/typetest/Machine.tst.ts", "machine-test"],
  ["typetest/AtomMachine.tst.ts", "packages/effect/typetest/unstable/reactivity/AtomMachine.tst.ts", "atom-typetest"],
  ["typetest/ClusterMachine.tst.ts", "packages/effect/typetest/ClusterMachine.tst.ts", "cluster-typetest"]
]

const effectImports = (text, depth) => text.replace(/from "effect\/([A-Za-z]+)"/g, `from "${depth}/$1.ts"`)

const localTs = (text) => text.replace(/from "(\.{1,2}\/[^"]+)\.js"/g, 'from "$1.ts"')

function transform(text, kind) {
  if (kind === "machine") {
    text = effectImports(text, "../..")
      .replace('import * as Inspectable from "../../Inspectable.ts"\n', "")
      .replace(
        'import * as Option from "../../Option.ts"\nimport { type Pipeable, Prototype as PipeablePrototype } from "../../Pipeable.ts"',
        'import { PipeInspectableProto } from "../../internal/core.ts"\nimport * as Option from "../../Option.ts"\nimport type { Pipeable } from "../../Pipeable.ts"'
      )
      .replace("  ...Inspectable.BaseProto,\n  ...PipeablePrototype,", "  ...PipeInspectableProto,")
  } else if (kind === "internal") {
    text = effectImports(text, "../../..")
  } else if (kind === "atom") {
    text = effectImports(text, "../..")
      .replace('from "./Machine.js"', 'from "../machine/Machine.ts"')
      .replace(
        'import { AsyncResult, Atom, type AtomRegistry } from "effect/unstable/reactivity"',
        'import * as AsyncResult from "./AsyncResult.ts"\nimport * as Atom from "./Atom.ts"\nimport type * as AtomRegistry from "./AtomRegistry.ts"'
      )
  } else if (kind === "cluster") {
    text = effectImports(text, "../..")
      .replace('from "./Machine.js"', 'from "../machine/Machine.ts"')
      .replace('import { Rpc } from "effect/unstable/rpc"', 'import * as Rpc from "../rpc/Rpc.ts"')
      .replace(
        /import \{\n  ClusterError,\n  ClusterSchema,\n  Entity,\n  EntityAddress,\n  MessageStorage,\n  type Sharding,\n  Snowflake\n\} from "effect\/unstable\/cluster"\n\n(?:type .+\n){3}/,
        'import type { PersistenceError } from "./ClusterError.ts"\nimport * as ClusterSchema from "./ClusterSchema.ts"\nimport * as Entity from "./Entity.ts"\nimport type { EntityAddress } from "./EntityAddress.ts"\nimport * as MessageStorage from "./MessageStorage.ts"\nimport type * as Sharding from "./Sharding.ts"\nimport type { Snowflake } from "./Snowflake.ts"\n'
      )
  } else if (kind === "machine-test") {
    text = text.replace(
      'import { Machine } from "../src/index.js"',
      'import { Machine } from "effect/unstable/machine"'
    )
  } else if (kind === "atom-test") {
    text = text
      .replace('import { Machine } from "../src/index.js"', 'import { Machine } from "effect/unstable/machine"')
      .replace(
        'import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity"\nimport { AtomMachine } from "../src/reactivity.js"',
        'import { AsyncResult, Atom, AtomMachine, AtomRegistry } from "effect/unstable/reactivity"'
      )
  } else if (kind === "atom-typetest") {
    text = text
      .replace('import { Machine } from "../src/index.js"', 'import { Machine } from "effect/unstable/machine"')
      .replace(
        'import { Atom } from "effect/unstable/reactivity"\nimport { AtomMachine } from "../src/reactivity.js"',
        'import { Atom, AtomMachine } from "effect/unstable/reactivity"'
      )
  } else if (kind === "cluster-test") {
    text = text
      .replace("  ClusterError,\n", "  ClusterError,\n  ClusterMachine,\n")
      .replace('import { ClusterMachine } from "../src/cluster.js"\n', "")
      .replace('import { Machine } from "../src/index.js"', 'import { Machine } from "effect/unstable/machine"')
  } else if (kind === "cluster-typetest") {
    text = text
      .replace(
        'import { type MessageStorage, type Sharding } from "effect/unstable/cluster"\nimport { ClusterMachine } from "../src/cluster.js"',
        'import { ClusterMachine, type MessageStorage, type Sharding } from "effect/unstable/cluster"'
      )
      .replace('import { Machine } from "../src/index.js"', 'import { Machine } from "effect/unstable/machine"')
  }
  return localTs(text)
}

let drift = false
for (const [source, target, kind] of files) {
  const expected = transform(await readFile(resolve(root, source), "utf8"), kind)
  const targetPath = resolve(effectRoot, target)
  if (check) {
    let actual
    try {
      actual = await readFile(targetPath, "utf8")
    } catch {
      actual = undefined
    }
    if (actual !== expected) {
      drift = true
      console.error(`drift: ${target}`)
    }
  } else {
    await mkdir(dirname(targetPath), { recursive: true })
    await writeFile(targetPath, expected)
    console.log(`wrote: ${target}`)
  }
}

if (drift) process.exitCode = 1
else console.log(check ? "Effect checkout is synchronized." : "Effect files synchronized.")
