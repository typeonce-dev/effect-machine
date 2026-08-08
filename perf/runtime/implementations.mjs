import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import * as XStateV5 from "xstate-v5"
import * as XStateV6 from "xstate-v6"
import { effectMachineAdapter } from "./counter.mjs"
import { makeEffectMemoryAdapter } from "./effect-memory.mjs"
import { makeXStateAdapter } from "./xstate.mjs"

const readPackageVersion = (path) => JSON.parse(readFileSync(path, "utf8")).version
const implementationRoot = resolve(
  process.env.EFFECT_MACHINE_BENCHMARK_ROOT ?? fileURLToPath(new URL("../..", import.meta.url))
)

export const packageVersions = {
  effectMachine: readPackageVersion(resolve(implementationRoot, "package.json")),
  effect: readPackageVersion(resolve(implementationRoot, "node_modules/effect/package.json")),
  tinybench: readPackageVersion(new URL("../../node_modules/tinybench/package.json", import.meta.url)),
  xstateV5: readPackageVersion(new URL("../../node_modules/xstate-v5/package.json", import.meta.url)),
  xstateV6: readPackageVersion(new URL("../../node_modules/xstate-v6/package.json", import.meta.url))
}

export const implementations = [
  { ...effectMachineAdapter, version: packageVersions.effectMachine },
  makeXStateAdapter({
    implementation: "xstate-v5",
    label: "XState 5",
    version: packageVersions.xstateV5,
    xstate: XStateV5
  }),
  makeXStateAdapter({
    implementation: "xstate-v6",
    label: "XState 6 alpha",
    version: packageVersions.xstateV6,
    xstate: XStateV6
  })
]

export const memoryImplementations = [
  ...implementations,
  makeEffectMemoryAdapter(packageVersions.effect)
]
