---
"@typeonce/effect-machine": patch
---

Compact running machine workers into a single generator loop and allocate emitted-event runtime closures only when a machine emits, reducing idle heap and improving event throughput without changing scheduler yield semantics.
