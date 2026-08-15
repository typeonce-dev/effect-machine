---
"@typeonce/effect-machine": minor
---

Rename the minimal inter-machine reference types so they use machine terminology and remain distinct from Effect Cluster concepts.

```ts
Machine.ActorRef<Event> // before
Machine.MachineTarget<Event> // after

Machine.ActorContext<InputEvents, ParentEvents> // before
Machine.MachineReferences<InputEvents, ParentEvents> // after
```

The inferred `self` and `parent` fields and all runtime behavior are unchanged.
