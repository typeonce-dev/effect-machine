---
"@typeonce/effect-machine": minor
---

`ClusterMachine` runs the effects invoked by active states. An entity starts the work once the state that owns it is stored, applies the result as a step of its own, and is kept alive while work should run. After a crash, Cluster brings the entity up on another runner without a request, and the work of the stored state starts again.

Work runs at least once and must be safe to repeat. Input mappers run again on recovery, with `Machine.InitialEvent`, and results are never stored: only the state they lead to is. Work that ends in a way the model does not handle fails the machine. The failure is stored with the last state, and later requests are rejected with the new reason `"MachineFailed"`. Timers, streams, process logic, and child machines are still rejected.

To migrate a `Storage` implementation, rename `load` to `loadForRequest`, add a `load(address)` that returns only the checkpoint, and deduplicate only requests in `commit`:

```ts
const { origin, revision } = checkpoint
if (origin._tag === "Request" && requestIds.has(origin.requestId)) return CommitResult.Duplicate()
if (revision !== (stored?.revision ?? 0) + 1) return CommitResult.RevisionConflict()
return CommitResult.Committed() // after storing the checkpoint, and the request id when there is one
```

`Checkpoint.requestId` is now `Checkpoint.origin`, and `Checkpoint.status` is new. Give checkpoints stored before this change `origin: { _tag: "Request", requestId }` and `status: { _tag: "Active", settled: [] }`. A checkpoint loaded without a status is rejected as `"InvalidCheckpoint"`.
