import { readFileSync } from "node:fs"
import * as XStateV5 from "xstate-v5"
import * as XStateV6 from "xstate-v6"
import { effectMachineAdapter } from "./counter.mjs"
import { makeXStateAdapter } from "./xstate.mjs"

const readPackageVersion = (path) => JSON.parse(readFileSync(path, "utf8")).version

export const packageVersions = {
  effectMachine: readPackageVersion(new URL("../../package.json", import.meta.url)),
  effect: readPackageVersion(new URL("../../node_modules/effect/package.json", import.meta.url)),
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
