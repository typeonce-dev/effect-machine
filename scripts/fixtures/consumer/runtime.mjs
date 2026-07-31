import assert from "node:assert/strict"
import { Machine } from "@typeonce/effect-machine"
import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { ClusterMachine } from "@typeonce/effect-machine/cluster"

assert.equal(typeof Machine.make, "function")
assert.equal(typeof AtomMachine.make, "function")
assert.equal(typeof ClusterMachine.make, "function")
