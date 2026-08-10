---
"@typeonce/effect-machine": patch
---

Start eligible compiled invoked machines directly from their synchronous initial kernel while preserving per-instance input evaluation, inherited services, scoped ownership, observation, and terminal behavior. Reuse the immutable process descriptor captured by `Machine.invokeMachine` across parent instances.
