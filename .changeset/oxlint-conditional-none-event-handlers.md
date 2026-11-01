---
"@typeonce/oxlint-plugin-effect-machine": patch
---

`effect-machine/no-conditional-none-branch` now checks only event handlers in `on`. `Machine.can` queries events, so resolvers for invocation outcomes such as `onSnapshot` and `onDone`, and for eventless `always` transitions, may select a `none` branch conditionally:

```ts
onSnapshot: {
  branches: "progress",
  resolve: ({ snapshot, select }) => snapshot.ready ? select.ready() : select.waiting()
}
```

Remove any suppression comments added for these resolvers.
