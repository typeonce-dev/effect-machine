---
"@typeonce/effect-machine": minor
---

Allow conditional `Machine.transition` definitions to infer any number of heterogeneous cases. Define `cases` with its locally supplied `branch` constructor so each predicate match and selected target remain exact in the corresponding resolver:

```ts
Machine.transition({
  cases: (branch) => [
    branch({
      title: "cached",
      when: ({ event }) => event.cached,
      target: (to) => to.full.Ready(),
      resolve: ({ match, target }) => target.from({ data: match })
    })
  ],
  otherwise: {
    target: (to) => to.full.Loading(),
    resolve: ({ target }) => target.from()
  }
})
```

Replace each object previously written directly in the `cases` array with `branch({ ... })` inside the `cases: (branch) => [...]` factory. Direct transitions and `otherwise` keep their existing shape.
