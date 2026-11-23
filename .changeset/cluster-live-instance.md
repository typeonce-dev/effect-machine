---
"@typeonce/effect-machine": minor
---

`ClusterMachine` keeps one live machine instance in memory per active entity. The checkpoint is loaded and decoded once, not for every request, and storage remains the truth: memory is loaded again after a failure, a passivation, or a conflict. A request redelivered to a live entity can run its resolvers again before storage recognizes it, so resolvers must stay free of effects.

`ClusterMachine.Checkpoint` has a new `revision`, and `Storage.commit` must refuse a stale write with the new `CommitResult.RevisionConflict`. This stops an entity that lost its shard from overwriting a newer checkpoint. A conflicted request is applied once more to the stored state, and then rejected with the new reason `"RevisionConflict"`.

To migrate a `Storage` implementation, persist `checkpoint.revision` and decide each commit atomically, in this order:

```ts
if (requestIds.has(checkpoint.requestId)) return CommitResult.Duplicate()
if (checkpoint.revision !== (stored?.revision ?? 0) + 1) return CommitResult.RevisionConflict()
return CommitResult.Committed() // after storing the checkpoint and its request id
```

Give checkpoints stored before this change revision `1`. A checkpoint loaded without a positive integer revision is rejected as `"InvalidCheckpoint"`. Stop instances of the previous version before migrating, because they neither assign nor check revisions.
