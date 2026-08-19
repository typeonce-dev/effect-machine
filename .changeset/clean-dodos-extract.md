---
"@typeonce/effect-machine": minor
---

Add consumer-facing state and startup-input extractors. `Machine.Snapshot`, `Machine.Value`, and `Machine.SnapshotAt` accept either the object returned by `Machine.states` or a machine definition, while preserving exact path validation and excluding control-only paths from `Value`.

`Machine.Machine.Input<M>` now extracts the decoded startup value and is `never` when the machine uses `Schema.Void`. Code that needs the startup schema should migrate from `Machine.Machine.Input<M>` to `Machine.Machine.InputSchema<M>`; code that previously used `Machine.Machine.Input<M>["Type"]` can use `Machine.Machine.Input<M>` directly.
