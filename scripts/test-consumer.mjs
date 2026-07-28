import assert from "node:assert/strict"

const root = await import("../dist/index.js")
const reactivity = await import("../dist/reactivity.js")
const cluster = await import("../dist/cluster.js")

assert.equal(typeof root.Machine.make, "function")
assert.equal(typeof reactivity.AtomMachine.make, "function")
assert.equal(typeof cluster.ClusterMachine.make, "function")
console.log("built root, reactivity, and cluster entrypoints imported successfully")
