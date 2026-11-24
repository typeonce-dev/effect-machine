---
"@typeonce/effect-machine": minor
---

Read a Cluster machine from outside its entity.

A `ClusterMachine.Client` now has `snapshot`, `changes`, and `join`, as a local reference does. They read the machine from `ClusterMachine.Storage` and never ask the entity, so a read works from any process that reaches the store, whichever runner owns the entity, and whether or not it is in memory. Reading does not wake the entity or keep it alive.

```ts
const client = (yield* adapter.client)("order-1")
const snapshot = yield* client.snapshot // Option<ClusterMachine.Snapshot<M>>
const output = yield* client.join.pipe(
  Effect.catchTag("MachineFailedError", (failed) => Effect.die(failed.failure))
)
```

`ClusterMachine.Snapshot` is `active`, `done` with the output, or `failed` with the text of the failure, each with its revision. The view is narrower than a local `MachineRef`: reads see committed checkpoints only, `changes` reads again after each `readInterval` (a new option of `ClusterMachine.make`, one second by default) and may skip checkpoints committed between two reads, a failure is text rather than a `Cause`, and there is no `stopped` status.

Reads require `ClusterMachine.Storage`. A checkpoint of another definition or version, or one the machine cannot hold, fails the read with `ClusterMachine.ReadError`.
