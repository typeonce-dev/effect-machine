---
"@typeonce/effect-machine": minor
---

Let Cluster machines send to each other.

`ClusterMachine.make` returns an adapter with `target(entityId)`, a `ClusterMachine.Target` that names the entity of that machine by its type and id, as Cluster addresses it. On Cluster, `self` is the target of the machine's own entity.

```ts
Pay: {
  target: "Paid",
  commands: ({ event, state }, enqueue) =>
    enqueue.sendTo(Ledger.target(state.ledger), { _tag: "Add", amount: event.amount })
}
```

An event that a step sends with `enqueue.sendTo` is saved as a persisted request to the target in the `MessageStorage` transaction of the step's checkpoint, so it is sent only when the step is stored, and the target applies it once. Work sends with `send` of a target, through the client of the target. The event is checked against the input events of the target at compile time.

Migration: work that read `self.sessionId` or called `self.send` failed the machine before. It now reads the address of the entity, `Type/entityId`, and sends to the entity. A step that sends to a target that is not a `ClusterMachine.Target`, such as a child, and `enqueue.stop`, are still rejected as `UnsupportedProcessLocal`.
