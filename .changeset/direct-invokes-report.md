---
"@typeonce/effect-machine": patch
---

Reduce invoked-child memory and lifecycle overhead by delivering terminal outcomes directly through process supervision and allocating a watcher fiber only for invokes that map active child snapshots.
