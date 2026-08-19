---
"@typeonce/effect-machine": minor
---

Make definition-time topology instructions immutable values. Use `to.none`, declared `.initial` and history properties, and `to.local.with` without an empty call; state and choice destinations such as `to.full.Running()` remain callable.

Author machine startup through the same target-first grammar: `initial: (to) => to.Flow.initial.resolve(...)`. The selector is captured once and its resolver remains lazy until initial planning.

Remove `Machine.targetless` and the `{ target: Machine.targetless, resolve }` shorthand. Use `(to) => to.none` or `(to) => to.none.resolve(...)`; block-bodied targetless resolvers may omit an explicit `return undefined`.
