---
"@typeonce/effect-machine": minor
---

Replace `Machine.invoke` and its object-configuration helper types with state-local fluent invocation chains. Select an Effect, Stream, timer, process logic, or child from the handler's `from` parameter, then handle every reachable lifecycle channel before returning the chain:

```ts
machine.handle({
  Loading: {
    invoke: (from) =>
      from.effect("load", () => loadUser())
        .onDone((to) => to.full.Ready())
        .onFailure((to) => to.full.Failed())
  }
})
```

Return an array of completed chains for multiple activities. Sources and child descriptors remain reusable, while keeping the invocation declaration local preserves exact owner-state, event, parent, output, failure, element, snapshot, and service inference.
