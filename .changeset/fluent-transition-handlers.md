---
"@typeonce/effect-machine": minor
---

Replace `Machine.transition(...)` with fluent transition selectors supplied directly to inline handlers. Select a target and optionally attach its resolver, reentry, or named branches without an intermediate wrapper:

```ts
const handlers = {
  Start: (to) => to.full.Running().resolve(({ event, target }) => target.from({ count: event.count })),

  Route: (to) =>
    to.branches({
      running: { target: to.full.Running() },
      done: { target: to.full.Done() },
      unchanged: { target: to.none() }
    }).resolve(({ event, select }) => event.cached ? select.done.from() : select.running.from())
}
```

Use `.reenter()` for resolver-free reentry, or pass literal `declinable: true` to `.resolve(...)` when the resolver must receive `decline()`. Bare targets are accepted only when their schemas support default construction.

Remove the machine-definition `.invoke(...)` method. Use `Machine.invoke(...)` in every state; it now retains the owning state, event, parent-event, output, error, element, snapshot, and service inference directly inside `handle(...)`.
