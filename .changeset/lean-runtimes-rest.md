---
"@typeonce/effect-machine": patch
---

Reduce managed runtime memory and lifecycle overhead by removing redundant process coordination state, reusing the live runtime service, and allocating invoke management only for machines with invoke definitions.
