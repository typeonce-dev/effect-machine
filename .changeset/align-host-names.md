---
"@typeonce/effect-machine": minor
"@typeonce/effect-machine-devtools": minor
---

Three names now say the same thing on every host. Behavior does not change.

| Before                                                          | After              |
| --------------------------------------------------------------- | ------------------ |
| `Machine.Enqueue`                                               | `Machine.Commands` |
| `RuntimeSnapshot` status `"error"`                              | `"failed"`         |
| Invocation `type: "process"` of `Machine.invocationDefinitions` | `type: "logic"`    |
| `MachineDocument.Invocation` `type: "process"`                  | `type: "logic"`    |

`Machine.Commands` is the type of the `commands` argument of a transition, so the type now has the name of the value. A failed machine reads `"failed"` on `LocalMachine`, `AtomMachine`, and `ClusterMachine`, as `MachineFailedError` and the rejection reason `"MachineFailed"` already did. Replace `snapshot.status === "error"` with `snapshot.status === "failed"`. A local snapshot still carries the `Cause`, and a Cluster snapshot the failure as text. A state that invokes a `Logic` is now listed as `"logic"`, the name of the module, instead of `"process"`. Export saved machine documents and static sites again.
