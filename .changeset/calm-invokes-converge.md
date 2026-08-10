---
"@typeonce/effect-machine": patch
---

Consolidate generic and compiled state-scoped invocation lifecycle handling behind one owner-local child registry, preserving duplicate detection, stale callback isolation, and path-scoped teardown without changing the public API.
