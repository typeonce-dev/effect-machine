---
"@typeonce/effect-machine": minor
---

Make `Machine.events` and `Machine.internalEvents` definition-time protocol descriptors that are passed directly to `Machine.make`. The descriptors expose type-safe deferred constructors while retaining their schemas privately, so applications can export the event API without exporting schemas or reaching for throwing schema `.make` methods.

```ts
const Events = Machine.events(PublicEvent)
const InternalEvents = Machine.internalEvents(InternalEvent)

const machine = Machine.make({
  states: States.states,
  events: Events,
  internalEvents: InternalEvents,
  initial: () => States.initial.Idle.from()
})
```

Remove the eager schema-based `Machine.event` constructor. Pass complete decoded event objects directly to APIs that intentionally retain values, such as manual model-testing scenarios or transport messages.
