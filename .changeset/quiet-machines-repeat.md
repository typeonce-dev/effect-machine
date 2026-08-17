---
"@typeonce/effect-machine": minor
---

Add `Machine.state` for topology that is genuinely reused at multiple mounts, plus definition-bound `States.path(...)` and `Machine.Snapshot<typeof States>` helpers for checked finite path families and snapshot queries.

Rename `Machine.defineStates` to `Machine.states`. Migrate by replacing `Machine.defineStates({...})` with `Machine.states({...})`; one-off topology should remain inline in that complete state definition. The returned state tree is now an immutable structural capture, so repeated mounts do not retain shared caller-owned configuration objects.
