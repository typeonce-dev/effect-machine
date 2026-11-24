---
"@typeonce/effect-machine": minor
---

Store Cluster machines durably in SQL with `SqlMachineStorage`, from `@typeonce/effect-machine/cluster`.

It provides `ClusterMachine.Storage` over the `SqlClient` that `SqlMessageStorage` uses. A step of a machine runs in the transaction of `MessageStorage`, and its commit joins it, so the checkpoint, the events the step emits, and the reply are stored together or not at all.

```ts
import { SqlMachineStorage } from "@typeonce/effect-machine/cluster"
import { Layer } from "effect"
import { SqlMessageStorage } from "effect/cluster"

const storage = Layer.mergeAll(SqlMessageStorage.layer, SqlMachineStorage.layer)
```

`layer`, `layerWith`, and `make` run the migrations, which create `<prefix>_checkpoints` and `<prefix>_requests` (prefix `cluster_machine` by default). `layerMigrations` and `layerStorage` separate migrating from running. PostgreSQL and SQLite are supported.

`ClusterMachine.checkStorage` checks that a `Storage` of your own keeps the contract machines rely on: fields stored unchanged, `Duplicate` before `RevisionConflict` before `Committed`, nothing written by a rejected commit, commits without a request never duplicates, entities kept apart, one winner between concurrent commits, and, given the `withTransaction` of `MessageStorage`, rollback with it. It fails with `ClusterMachine.StorageCheckFailure`, naming the scenario.
