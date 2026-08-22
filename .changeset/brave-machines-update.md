---
"@typeonce/effect-machine": minor
---

Add `to.local.update(...)` and `to.branch.<path>.update(...)` for replacing an active compound or parallel state's value without reconstructing its active descendants.

Updates accept decoded values through `target(value)` or schema make input through `target.from(input)`. They preserve descendant configuration and state-owned work by default, support named branches and declinable resolvers, and expose the updated owner through transition inspection.
