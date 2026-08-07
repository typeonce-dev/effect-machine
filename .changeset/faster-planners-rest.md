---
"@typeonce/effect-machine": patch
---

Reduce runtime planner allocation overhead by reusing compiled schema decoders and state topology paths, deferring effect service allocation until it is needed, and avoiding unused snapshots.
