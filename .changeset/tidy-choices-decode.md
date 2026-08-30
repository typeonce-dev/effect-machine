---
"@typeonce/effect-machine": patch
---

Fix initial choice resolvers so schema-backed `containingState` and `ancestors` are decoded before the choice runs.

This makes `.from(...)` state construction behave the same for transient initial choices as it does for ordinary active-state entry.
