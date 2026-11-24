import type { Effect, Layer } from "effect"
import type { ClusterError } from "effect/cluster"
import type * as SqlClient from "effect/sql/SqlClient"
import { describe, expect, it } from "tstyche"
import { ClusterMachine, SqlMachineStorage } from "../../../src/unstable/cluster/index.js"

describe("SqlMachineStorage", () => {
  it("provides Storage from a SqlClient", () => {
    expect(SqlMachineStorage.layer).type.toBe<Layer.Layer<ClusterMachine.Storage, never, SqlClient.SqlClient>>()
    expect(SqlMachineStorage.layerWith({ prefix: "orders" })).type.toBe<
      Layer.Layer<ClusterMachine.Storage, never, SqlClient.SqlClient>
    >()
    expect(SqlMachineStorage.layerMigrations()).type.toBe<Layer.Layer<never, never, SqlClient.SqlClient>>()
    expect(SqlMachineStorage.make()).type.toBe<
      Effect.Effect<ClusterMachine.Storage["Service"], never, SqlClient.SqlClient>
    >()
    expect(SqlMachineStorage.layerWith).type.not.toBeCallableWith({ prefix: 1 })
  })

  it("checks any Storage", () => {
    const storage = null! as ClusterMachine.Storage["Service"]
    expect(ClusterMachine.checkStorage(storage)).type.toBe<
      Effect.Effect<void, ClusterMachine.StorageCheckFailure | ClusterError.PersistenceError>
    >()
  })
})
