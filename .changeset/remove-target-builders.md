---
"@typeonce/effect-machine": minor
"@typeonce/effect-machine-devtools": minor
---

Remove the target builder types `Machine.Machine.TargetBuilder`, `LocalTargetBuilder`, `BranchTargetBuilder`, `FullTargetBuilder`, and `HistoryTargetBuilder`. No API accepts or returns them since transitions became declarations: name a destination with `target`, `update`, `history`, `initialize`, or `stay` instead, and type a snapshot with `Machine.Machine.SnapshotByIdentifier`.

In the devtools, `MachineWalkthrough.Choice` no longer has a `title` field. It always held the same value as `branchKey`, the `branches` entry as written, such as `target:Paid`. Read `branchKey` instead.

The API reference now describes the current API, including `Machine.make`, `Machine.logic`, `Machine.eventsFromSchemas`, and the transition inspection types.
