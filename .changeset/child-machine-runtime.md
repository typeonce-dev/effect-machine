---
"@typeonce/effect-machine": minor
---

Let work act on the child machines of its state on Cluster.

`Machine.sendTo` and `Machine.stopChild` with the descriptor of a child machine now require a new capability, `Machine.ChildMachineRuntime`, instead of `Machine.MachineRuntime`. `LocalMachine`, `AtomMachine`, and `ClusterMachine` provide it, so a Cluster machine whose invoked work sends to the child of its state, or stops it, now compiles and runs.

```ts
effects: {
  drive: Machine.sendTo(Counter, { _tag: "Add", by: 5 })
}
// Effect<void, StoppedError, Machine.ChildMachineRuntime>
```

On Cluster, the work acts on the child that runs when it acts, through a persisted request saved outside the transaction of a step, and ignores a child that does not run, as a local host does.

`Machine.spawn`, and `Machine.sendTo` and `Machine.stopChild` with a child address, still require `Machine.MachineRuntime`, which only a local host provides.

Migration: a helper typed as requiring `Machine.MachineRuntime` that calls `Machine.sendTo` or `Machine.stopChild` with a child descriptor still compiles, but a type that expects the result of such a call to require exactly `Machine.MachineRuntime` now sees `Machine.ChildMachineRuntime`. `LocalMachine.RequiredServices` removes both.
