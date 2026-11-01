---
"@typeonce/effect-machine": patch
---

Internal: check the compiled execution plan's transition contexts, targets, and commands at compile time instead of through `any` casts. Machine behavior and the public API are unchanged.
