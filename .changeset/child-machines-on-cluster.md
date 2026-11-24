---
"@typeonce/effect-machine": minor
---

Run child machines on Cluster.

`ClusterMachine.make` now accepts a machine whose states invoke a child machine. Each child runs as an entity of its own, of type `Type/childId`, which the layer of the parent registers with the same version. Each activation of the state starts a new child, `entityId/childId/revision`. The step that enters the state saves the start of the child with its input, and the step that exits it saves its stop, both in the transaction of the step's checkpoint, so a child runs exactly while its state is stored.

```ts
const Counter = Machine.child("counter", counter)

Hosting: {
  invoke: { src: "counter", input: ({ event }) => event.name, onDone: { target: "Ready" } },
  on: { Add: { stay: true, commands: ({ event }, enqueue) => enqueue.sendTo(Counter, event) } }
}
```

`enqueue.sendTo` with the descriptor of a child sends to the child that runs, and drops the event when none does. A child's `parent` is the target of its parent. A child that ends tells its parent, which applies its output as the end of the invocation. A child that fails fails its parent, also when the parent declares `onFailure`. A machine that fails or ends stops its children.

A child is type checked as its own Cluster machine: a child that invokes a Stream or a `Logic`, or requires `Machine.MachineRuntime`, still makes its parent refused, and the error names what the child uses.

New public types: `ClusterMachine.Checkpoint.Progress.Child`, `ClusterMachine.Checkpoint.Status.Stopped`, and the `"stopped"` status of a read snapshot. `join` of a stopped machine fails with `MachineFailedError`.

Migration: machines now send to each other through a new `deliver` request instead of `send`. Nobody waits for its answer, so the target treats it as a local machine treats an event sent to it: an event that the target cannot apply, such as one whose transition throws, now fails the target, where before it was rejected and dropped. Code that matches on `Checkpoint.Status` or the read status must handle `Stopped` and `"stopped"`.
