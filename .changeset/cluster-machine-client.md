---
"@typeonce/effect-machine": minor
---

Add `ClusterMachine.Client`, a client for one Cluster machine that takes what `send` of a local reference takes. Create it from the adapter, as `Entity.client` does:

```ts
const client = (yield * adapter.client)("document-1")
yield * client.send(Events.Rename({ name: "report" }))
```

It accepts events built by the constructors of `Machine.events`, which the raw entity client refused. An event that its schema refuses is rejected as `"InvalidEvent"` before it is sent, and the machine goes on, instead of a defect in the caller. Rejections, including those of the machine, fail the effect with `ClusterMachine.Rejected`, now a yieldable error; Cluster failures such as a full mailbox are `ClusterMachine.ClientError`s.

`ClusterMachine.RejectionReason` gains `"InvalidEvent"`.
