---
"@typeonce/effect-machine": patch
---

Preserve every machine protocol channel when creating bound AtomMachine bridges from deeply composed handled machines. Inline invoked children also retain their exact error, service, event, and output types instead of inheriting erased contextual `any` channels.
