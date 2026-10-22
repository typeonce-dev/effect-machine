---
"@typeonce/effect-machine": minor
---

`ChildAlreadyExistsError` now appears in a machine's error type only for invocations whose child id you choose: logic invocations with an `address` and `Machine.child` invocations. Effect, Stream, and timer invocations run under runtime-owned ids and cannot collide, so a machine that only invokes them no longer carries `ChildAlreadyExistsError` in `Machine.Error`. Invocation ids within one state must be distinct; a repeated source without distinct `id`s or a reused `id` is now a type error and is rejected when the machine is constructed.

A parent that invokes a fixed child through `children` now needs `onFailure` exactly when the child's own error type is reachable. Remove `onFailure: { none: true }` handlers that only swallowed `ChildAlreadyExistsError`; they are now rejected as unreachable, like an unreachable `onDone`.

Constraint failures now explain themselves instead of reporting `never`. Starting, resuming, preparing, or planning a machine with a required parent reports `Machine declares a required parent and cannot run as a root`, and an unreachable `onDone`, `onFailure`, `onElement`, or `onSnapshot` names the channel and source, for example `Invocation 'forever' never completes, so onDone is unreachable`.
