---
"@typeonce/oxlint-plugin-effect-machine": minor
---

Add the recommended `effect-machine/no-conditional-none-branch` rule.

A `{ none: true }` branch accepts its event, so `Machine.can` and `AtomMachine.can` return `true` when a resolver selects it. The rule reports a resolver that selects a `none` branch conditionally without `declinable: true`. When the event must be refused, for example to disable a control, decline it instead:

```ts
Submitted: {
  branches: "submit",
  declinable: true,
  resolve: ({ state, select, decline }) => state.complete ? select.review() : decline()
}
```
