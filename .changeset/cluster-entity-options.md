---
"@typeonce/effect-machine": minor
---

Expose Cluster `Entity` tuning options, `shardGroup` routing, and a transactional `onCommit` hook on `ClusterMachine`.

- `ClusterMachine.make` now accepts an optional `shardGroup?: (entityId: EntityId) => string` option, annotating both the entity and any invoked child entities with `ClusterSchema.ShardGroup`.
- `ClusterMachine.toLayer` now accepts `LayerOptions<M, RE, RC>`, forwarding Effect Cluster's `Entity.toLayer` options (`maxIdleTime`, `concurrency`, `mailboxCapacity`, `mailboxMetrics`, `disableFatalDefects`, `defectRetryPolicy`, `spanAttributes`) to the entity and its children.
- Added `LayerOptions.onCommit` and `CommitEvent<M>`, which run inside the same `MessageStorage` transaction immediately after each checkpoint commit (active, done, or failed) so SQL read-model projections and audit tables commit or roll back atomically with the checkpoint.
