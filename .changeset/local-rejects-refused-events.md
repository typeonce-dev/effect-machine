---
"@typeonce/effect-machine": minor
---

`send` of a `LocalMachine` reference now rejects an event that the schema of the machine refuses with `MachineSchemaDecodeError`, and the machine keeps running, as `Machine.toStep` and `ClusterMachine` already do. `MachineTarget.send` and `MachineRef.send` add `MachineSchemaDecodeError` to their error channel, and so do the `send` atoms of `AtomMachine` and a rejected `MachineTest` send. An event that another machine, a child, or work delivers is not checked at its `send`: a refused one still fails the machine that plans it.

A timer that cannot start now has one failure mode: `Machine.MachineStep.Work.Timer.duration()` returns an `Exit`, which fails when the input mapper or the source throws and when the input names no duration. Every host settles the timer with that failure where it would have started.

A transition that throws follows one documented rule on every host: the error goes to the sender when one waits for the event to be processed, and otherwise the machine fails. Each host keeps its behaviour.

Every machine and every `Machine.logic` that `LocalMachine` runs now shares one process. A `send` to logic whose stop was already requested fails with `StoppedError`, as it does for a machine, and the `Initialized` inspection event of an inspected machine lists its entry paths and microsteps in the order of the reference planner.
