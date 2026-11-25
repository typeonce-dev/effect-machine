---
"@typeonce/effect-machine": minor
---

Support `enqueue.stop(Child)` in synchronous transitions and per-entity startup input via `client.start(...input)` on `ClusterMachine` and `ClusterMachineProxy`.

- `enqueue.stop(Child)` with a `ChildMachine` descriptor now stops the running child entity in the same transaction as the parent checkpoint, settles its invocation progress so it does not restart while its state remains active, and ignores a child that is not running. Passing a local `ChildAddress` still rejects as `UnsupportedProcessLocal`.
- `ClusterMachine.Client` and `ClusterMachineProxy.Client` now expose `start(...input)` (and `ClusterMachineProxy.toRpcGroup` adds `${Type}.start`), allowing each entity instance to be initialized with its own schema-validated input or to commit its initial state before receiving an event.
- `ClusterMachine.make` now accepts omitting the static default `input` for machines that declare `input`, requiring `client.start(input)` before sending events (or continuing to auto-start on `send` when a default input is supplied), and enforces that declared `input` schemas have JSON-compatible encoded representations.
