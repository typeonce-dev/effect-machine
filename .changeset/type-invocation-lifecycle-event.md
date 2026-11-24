---
"@typeonce/effect-machine": minor
---

Add `Machine.InvocationEvent`, the lifecycle event of a step caused by invoked work. When the output, typed failure, stream element, or child snapshot of an invocation leads to a transition, the `entry`, `exit`, `always`, and input-mapper callbacks of that step receive it as their `event`. It names the invoking state and invocation and what was reported:

```ts
entry: ;
;(({ event }) => {
  if (Machine.isInvocationEvent(event)) {
    event.path // "Loading"
    event.id // "load"
    event.kind // "Done" | "Failure" | "Element" | "Snapshot"
  }
})
```

`Machine.Machine.LifecycleEvent` now includes `Machine.InvocationEvent`, so code that treated every event other than `InitialEvent` as a declared event must also handle it. Before, such callbacks received an undocumented internal object. A machine restarted by `ClusterMachine` passes `InitialEvent` to the input mapper of restarted work.
