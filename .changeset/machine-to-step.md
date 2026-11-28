---
"@typeonce/effect-machine": minor
---

Add `Machine.toStep`, the pure form of a machine, for writing a host for a new runtime. Applications keep using `LocalMachine`, `AtomMachine`, or `ClusterMachine`.

`Machine.toStep(machine, { self })` returns synchronous functions that run nothing. `start`, `send`, `settle`, `element`, `stop`, and `resume` each return the next state as an immutable value, together with the events to send, the work to stop, the snapshot to publish, the emitted events, and the work to start, in that order. Work is an Effect, a timer, or a Stream. A result of work whose state was exited is ignored, so a host never compares generations, and a kept state can be stepped from again.

```ts
const step = Machine.toStep(machine, { self })
const loading = yield * step.send(started.state, Events.Load({ id: "a" }))
const loaded = step.settle(loading.state, work, yield * Effect.exit(work.effect))
```

`send` rejects an event that its schema refuses and keeps the machine. A machine that invokes a `Logic` or a child machine, or whose work requires `Machine.MachineRuntime` or `Machine.ChildMachineRuntime`, does not compile with `toStep`.
