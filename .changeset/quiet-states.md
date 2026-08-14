---
"@typeonce/effect-machine": minor
---

Allow active states to omit `schema` when they own no data. Schema-less atomic, compound, parallel, and final states keep full control-flow semantics while exposing value-free `.from(...)` builders, `undefined` handler state, and snapshot-only query APIs.

```ts
const States = Machine.defineStates({
  Form: {
    initial: "Editing",
    states: { Editing: {}, Saving }
  }
})

States.initial.Form.from((form) => form.Editing.from())
```
