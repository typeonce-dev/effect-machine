---
"@typeonce/effect-machine": minor
---

Replace conditional `cases` and `otherwise` transitions with named `branches`. Each branch declares one static target, while the required synchronous `resolve` function uses ordinary TypeScript control flow to return a typed `select` builder.

```ts
Machine.transition({
  branches: (to) => ({
    moving: { target: to.local.Running() },
    unchanged: { target: to.none() }
  }),
  resolve: ({ event, select }) =>
    event.axis === 0
      ? select.unchanged()
      : select.moving.from({ startedAt: event.at })
})
```

Branch keys are stable inspection, visualization, trace-verification, and coverage identities. Optional branch titles remain presentation metadata.
