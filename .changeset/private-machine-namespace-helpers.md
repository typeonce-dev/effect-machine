---
"@typeonce/effect-machine": minor
---

The `Machine.Machine` namespace now exposes only its public API. The internal helper types that implement `.handle` and its compile-time checks, such as `Machine.Machine.HandlerTreeEvidence`, `Machine.Machine.NormalizeObjectConfig`, and `Machine.Machine.ValidateObjectConfig`, are no longer reachable from outside the package, and the API reference no longer lists them.

Code that named one of these helpers should name the public type it was used to compute, such as `Machine.Machine.States`, `Machine.Machine.Snapshot`, or `Machine.Machine.StateHandler`. `Machine.Machine.HistoryDefaultEntry`, `Machine.Machine.ChoiceStateConfig`, `Machine.Machine.InvokeOwned`, and `Machine.Machine.EventConstructorInput` stay public and are now documented, because handler configurations and event constructors are declared with them. Declarations emitted for exported machines, child descriptors, atoms, event constructors, and handler helpers are unchanged.
