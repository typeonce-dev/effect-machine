import { assert, describe, it } from "@effect/vitest"
import * as ClusterChild from "../../../src/internal/machine/clusterChild.js"

describe("clusterChild", () => {
  it("name a child from its parent, its id, and the step that started it", () => {
    assert.strictEqual(ClusterChild.entityTypeOf("Host", "counter"), "Host/counter")
    assert.strictEqual(ClusterChild.entityIdOf("host-1", "counter", 3), "host-1/counter/3")
    assert.strictEqual(ClusterChild.parentEntityIdOf("host-1/counter/3", "counter"), "host-1")
    assert.strictEqual(ClusterChild.parentEntityIdOf("a/b/counter/12", "counter"), "a/b")
    assert.strictEqual(ClusterChild.parentEntityIdOf("host-1/other/3", "counter"), undefined)
    assert.strictEqual(ClusterChild.parentEntityIdOf("host-1/counter/x", "counter"), undefined)
    assert.strictEqual(ClusterChild.parentEntityIdOf("/counter/3", "counter"), undefined)
  })
})
