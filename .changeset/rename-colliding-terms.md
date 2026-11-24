---
"@typeonce/effect-machine": minor
"@typeonce/effect-machine-devtools": minor
---

Names that mean something else in Effect Workflow or Effect Cluster are renamed. Behavior does not change, but stored Cluster checkpoints need a migration.

An `Activity` of Effect Workflow runs once and its result is recorded. The work a state invokes is not recorded, so it is now called an invocation everywhere:

| Before                                                            | After                                                |
| ----------------------------------------------------------------- | ---------------------------------------------------- |
| `Machine.activityDefinitions`                                     | `Machine.invocationDefinitions`                      |
| `Machine.Machine.ActivityDefinition`                              | `Machine.Machine.InvocationDefinition`               |
| `Inspection.Activity`                                             | `Inspection.ProgramInvocation`                       |
| `Inspection.ActivityStarted` and its `_tag`                       | `Inspection.ProgramInvocationStarted`                |
| `Inspection.ActivityStopped` and its `_tag`                       | `Inspection.ProgramInvocationStopped`                |
| `activity` of both records                                        | `invocation`                                         |
| `Inspection.Causation`: `{ _tag: "Activity", activitySessionId }` | `{ _tag: "ProgramInvocation", invocationSessionId }` |
| `MachineDocument.Activity`                                        | `MachineDocument.Invocation`                         |
| `MachineDocument.State`: `activityIds`                            | `invocationIds`                                      |
| `MachineDocument.MachineDocument`: `activities`                   | `invocations`                                        |
| Ids `"<state>:activity:<n>"` in a machine document                | `"<state>:invocation:<n>"`                           |

`MachineDocument.schemaVersion` is now `4`. Export saved documents and static sites again.

A `MachineId` of Effect Cluster names the runner that generates an id. A checkpoint stores the id of a machine definition, and now says so:

| Before                                                  | After                    |
| ------------------------------------------------------- | ------------------------ |
| `ClusterMachine.Checkpoint`: `machineId`                | `definitionId`           |
| `ClusterMachine.RejectionReason`: `"MachineIdMismatch"` | `"DefinitionIdMismatch"` |
| Log annotation `machineId` of `ClusterMachine`          | `definitionId`           |

Stop the instances of the previous version, then rename `machineId` to `definitionId` in every stored checkpoint and keep its value. A checkpoint that still has `machineId` is rejected as `"DefinitionIdMismatch"`. Deploy clients together with runners: neither version decodes a `Rejected` reply, stored or sent, that has the other version's reason.

`Logic.Scope` sat next to Effect's `Scope` in the same signatures and meant something else. The capabilities given to `Logic` are renamed:

| Before          | After                  |
| --------------- | ---------------------- |
| `Logic.Scope`   | `Logic.InitialContext` |
| `Logic.Context` | `Logic.RunContext`     |
| `Logic.Address` | `Logic.Endpoint`       |

`ChildAddress` keeps its name: it is the typed id a parent uses to reach a child, which is what an address is in Effect Cluster. `Logic.Endpoint` is the object that sends to and stops a process.
