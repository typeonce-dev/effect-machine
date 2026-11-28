---
"@typeonce/effect-machine": minor
---

`ClusterMachine` now runs on `Machine.toStep`, so a Cluster entity decides which work stops and starts, and whether a result still applies, exactly as the step does. Stored checkpoints keep their format.

Three behaviours change on Cluster:

- Work that uses `Machine.MachineRuntime` fails the machine with `ProcessLocalError`, instead of a missing service.
- `children.sendTo` and `children.stop` in an input mapper reach the running child entity, as `Machine.sendTo` and `Machine.stopChild` already do. `children.spawn` is still refused.
- A send to a child that the same step enters is dropped, as it is on `LocalMachine`.

Each `Machine.MachineStep.Step` now lists the paths of the states it `exited` and `entered`, in order and each once, so a durable host can forget what it stored about exited states without building snapshots.
