---
"@typeonce/effect-machine": patch
---

Harden planning, snapshot round trips, and logical runtime resumption for valid typed machines. Initial choices no longer retain abandoned roots, history fallbacks resolve nested choices before snapshot normalization, and the independent finite-model oracle follows nested choice initializers.
