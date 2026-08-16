---
"@typeonce/effect-machine": minor
---

Add live, root-scoped machine inspection through `Machine.prepare(machine).inspection` and `AtomMachine.inspection(machineAtom)`.

The hot Effect `Stream` observes ordered creation, initialization, mailbox delivery and processing, state changes, emissions, Effect and timer activities, and termination for a prepared root and all locally owned descendants:

```ts
const prepared = yield * Machine.prepare(machine)

yield * prepared.inspection.pipe(
  Stream.runForEach((event) => Console.log(event.sequence, event.subject.id, event._tag)),
  Effect.forkScoped({ startImmediately: true })
)

const ref = yield * prepared.start
```

Inspection is non-replayed, never fails, and completes with the root. Its session ids and ordering are local to one prepared ownership tree; distributed identity and delivery remain an Effect Cluster concern.
