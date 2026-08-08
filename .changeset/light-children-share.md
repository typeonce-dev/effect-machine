---
"@typeonce/effect-machine": patch
---

Reduce child-machine ownership memory by consolidating supervision and registry state, tracking anonymous children without per-child scope finalizers, and allocating child observation resources only when consumed.
