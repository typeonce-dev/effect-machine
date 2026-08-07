import assert from "node:assert/strict"
import { Machine } from "@typeonce/effect-machine"
import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { ClusterMachine } from "@typeonce/effect-machine/cluster"
import { MachineTest } from "@typeonce/effect-machine/testing"

assert.equal(typeof Machine.make, "function")
assert.equal(typeof AtomMachine.make, "function")
assert.equal(typeof ClusterMachine.make, "function")
assert.equal(typeof MachineTest.scenarios, "function")
