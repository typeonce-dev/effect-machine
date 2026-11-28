---
"@typeonce/effect-machine": minor
---

Add `Machine.toStep`, the pure form of a machine, for writing a host for a new runtime. Applications keep using `LocalMachine`, `AtomMachine`, or `ClusterMachine`.

`Machine.toStep(machine, { self, parent, children })` returns synchronous functions that run nothing and call no user code. `start`, `send`, `settle`, `element`, `report`, `stop`, and `resume` each return the next state as an immutable value, together with the commands to carry out, the work to stop, the snapshot to publish, the emitted events, and the work to start, in that order. Work is an Effect, a timer, a Stream, a `Logic`, or a child machine, described as data that the host evaluates when it starts it. A result of work whose state was exited is ignored, so a host never compares generations, and a kept state can be stepped from again.

```ts
const step = Machine.toStep(machine, { self })
const loading = yield * step.send(started.state, Events.Load({ id: "a" }))
const effect = work.effect() // the source runs here, at most once
const loaded = step.settle(loading.state, work, Exit.isFailure(effect) ? effect : yield * Effect.exit(effect.value))
```

A step plans with the same compiled planner as `LocalMachine`, so a host built on `Machine.toStep` takes events about as fast as `LocalMachine` plans them.

`parent` is required for a machine that requires one, and `children` when its work acts on children. `resume` takes the progress of a durable host, so that work which ended does not run again. `Machine.MachineStep.Supported` lets a host refuse at compile time the kinds of work it does not run. `send` rejects an event that its schema refuses and keeps the machine.
