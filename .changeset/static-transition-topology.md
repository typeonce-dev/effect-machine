---
"@typeonce/effect-machine": minor
---

Require `Machine.transition` for every machine transition and capture each possible target as static machine topology. Direct transitions declare `target` and `resolve`; conditional transitions declare titled `cases` whose `when` functions return `Option`, plus an explicit `otherwise` branch. The selected target builder and conditional match value are inferred in each resolver.

Initial state construction now uses the same `target` and `resolve` shape, restricted to the machine's declared initial state. Replace process logic previously created with `Machine.transition` by `Machine.logic`, and replace function handlers, target upper-bound lists, and `States.initial` construction with the explicit transition and initial target selectors.
