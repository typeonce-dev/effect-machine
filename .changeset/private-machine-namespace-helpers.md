---
"@typeonce/effect-machine": minor
---

The `Machine.Machine` namespace now exposes only its public API. The internal helper types that implement `.handle` and its compile-time checks, such as `Machine.Machine.HandlerTreeEvidence`, `Machine.Machine.NormalizeObjectConfig`, and `Machine.Machine.ValidateObjectConfig`, are no longer reachable from outside the package, and the API reference no longer lists them.

Code that named one of these helpers should name the public type it was used to compute, such as `Machine.Machine.States`, `Machine.Machine.Snapshot`, `Machine.Machine.StateHandler`, or `Machine.Machine.HistoryDefaultEntry`, which is now documented as the shape of a history state's `default`. Declarations emitted for exported machines, child descriptors, atoms, and handler helpers are unchanged.
