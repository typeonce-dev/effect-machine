---
"@typeonce/effect-machine": patch
---

Reduce the retained memory of `childChanges` observers with a compact ordered handoff that avoids replaying complete child-registry snapshots.
