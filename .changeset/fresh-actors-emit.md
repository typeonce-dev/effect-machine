---
"@typeonce/effect-machine": minor
---

Separate actor inputs from outward notifications. Declare emissions with `Machine.emittedEvents`, publish them with `emit`, and observe the hot, non-replaying `MachineRef.emissions` stream. Children declare the public inputs they expect from their owner through `parentEvents`, then communicate explicitly with the typed, optional `parent` actor reference:

```ts
const Emissions = Machine.emittedEvents(Progress)
const ParentEvents = Machine.events(Completed)

const worker = Machine.make({
  // ...
  emittedEvents: Emissions,
  parentEvents: ParentEvents
}).handle({
  Working: {
    entry: ({ parent }, enqueue) => {
      enqueue.emit(Emissions.Progress({ value: 0.5 }))
      if (parent !== undefined) {
        enqueue.sendTo(parent, ParentEvents.Completed({ value: 42 }))
      }
    }
  }
})
```

Handler contexts also expose typed `self`; invoked-child composition checks that every `parentEvents` case is accepted by the parent. This release renames structural handler ancestry to `containingState` and `ancestors`, supports zero-payload event and emission constructors with `()`, and exposes root and child emission streams through AtomMachine.
