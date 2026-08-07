---
"@typeonce/effect-machine": minor
---

Add public getters for inspecting compiled state nodes, registered transition handlers, declared transition targets, and the active state configuration of a snapshot. Event, eventless, and completion handlers may declare an upper bound of target paths that is checked against inferred and runtime results.

Represent compiled state-node inspection as a six-way discriminated union so atomic, compound, parallel, final, history, and choice metadata narrow without impossible field combinations.
