---
"@typeonce/effect-machine": patch
---

Check the public `Machine` operations against their implementations at compile time.

`Machine.start`, `resume`, `plan`, `planInitial`, `can`, `enabled`, `isFinal`, `encodeSnapshot`, `decodeSnapshot`, `make`, and the event protocol builders no longer rely on unchecked casts, so their documented signatures now stay in sync with runtime behavior. Planning failures are classified consistently across runtime strategies: non-stabilization and schema failures stay typed, startup throws become `StartupError`, and other handler throws remain defects.
