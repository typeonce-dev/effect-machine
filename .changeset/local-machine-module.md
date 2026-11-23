---
"@typeonce/effect-machine": minor
---

The machine model and its in-memory host are now separate modules. `Machine` declares, plans, and encodes a machine, and depends on no host. The new `LocalMachine` runs it in memory, next to `AtomMachine` and `ClusterMachine`. How a machine is written and how it runs do not change.

Import `LocalMachine` from `@typeonce/effect-machine` and replace the moved names:

```ts
// before
const started = Machine.start(machine)
// after
const started = LocalMachine.start(machine)
```

- `Machine.start`, `Machine.prepare`, and `Machine.resume` are `LocalMachine.start`, `LocalMachine.prepare`, and `LocalMachine.resume`.
- `Machine.Prepared` and `Machine.Inspection` are `LocalMachine.Prepared` and `LocalMachine.Inspection`.
- `Machine.ExecutionServices` is `LocalMachine.RequiredServices`.

`Machine.MachineRef` now promises only what every host's reference provides. Processing an event in the sender's turn is documented as a guarantee of `LocalMachine.start`. The service behind `Machine.MachineRuntime` contains only `spawn`, `sendTo`, and `stopChild`, and child descriptors hold only an id and a machine.
