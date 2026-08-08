---
"@typeonce/effect-machine": patch
---

Let the Effect runtime scheduler control cooperative yielding while draining machine event bursts, preserving runtime scheduler configuration and avoiding a forced scheduler turn after every event.
