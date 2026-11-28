/** Hosts of the conformance suite that need internals of the library. */
import type { Host } from "../../../conformance/support/host.js"
import { makeLocalHost } from "../../../conformance/support/hosts/local.js"
import { openWithRuntimeStrategy, resumeWithRuntimeStrategy } from "./strategyDifferential.js"

const localHost = (strategy: "generic" | "compiled"): Host =>
  makeLocalHost({
    name: `LocalMachine (${strategy})`,
    start: (machine, ...input) => openWithRuntimeStrategy(machine, strategy, ...input),
    resume: (machine, snapshot) => resumeWithRuntimeStrategy(machine, snapshot, strategy)
  })

/** The reference of the suite. */
export const genericHost: Host = localHost("generic")

export const compiledHost: Host = localHost("compiled")
