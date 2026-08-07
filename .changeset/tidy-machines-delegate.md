---
"@typeonce/effect-machine": minor
---

Add typed `when` predicates to object-form event transitions. A false predicate rejects the child transition and continues normal hierarchical selection at ancestor states, while a selected transition returning `undefined` remains targetless and consumes the event. Conditional edges are exposed through machine inspection without evaluating predicates.
