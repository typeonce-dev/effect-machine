---
"@typeonce/effect-machine": patch
---

Run compiled statecharts and their invoked machine children with a single process fiber, reducing lifecycle overhead and idle memory while preserving the general `Machine.logic` runtime contract.
