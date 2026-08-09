---
"@typeonce/effect-machine": patch
---

Reduce the retained memory of invoked machines by running the original child logic with a compact guarded `sendParent` channel instead of allocating a wrapper process for every invocation.
