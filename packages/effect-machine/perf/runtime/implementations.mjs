import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { effectMachineAdapter } from "./counter.mjs"

const readPackageVersion = (path) => JSON.parse(readFileSync(path, "utf8")).version
const configuredRoot = resolve(
  process.env.EFFECT_MACHINE_BENCHMARK_ROOT ?? fileURLToPath(new URL("../..", import.meta.url))
)
const implementationRoot = existsSync(join(configuredRoot, "packages", "effect-machine", "package.json"))
  ? join(configuredRoot, "packages", "effect-machine")
  : configuredRoot

export const packageVersions = {
  effectMachine: readPackageVersion(resolve(implementationRoot, "package.json")),
  effect: readPackageVersion(resolve(implementationRoot, "node_modules/effect/package.json")),
  tinybench: readPackageVersion(new URL("../../node_modules/tinybench/package.json", import.meta.url))
}

export const implementations = [
  { ...effectMachineAdapter, version: packageVersions.effectMachine }
]

export const runtimeReferenceImplementations = implementations.filter(
  (implementation) => implementation.runtimeBenchmarks !== undefined
)

export const memoryImplementations = implementations
