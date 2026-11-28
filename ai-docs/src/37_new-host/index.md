## Write a host for a new runtime

Applications run machines with `LocalMachine`, `AtomMachine`, or
`ClusterMachine`. Use `Machine.toStep` only to run a machine somewhere these
hosts do not reach, such as a UI store that keeps the state itself.

`Machine.toStep(machine, { self })` returns pure functions. They run nothing:
each one returns the next state as a value, with the work to stop and to start.

```ts
const step = Machine.toStep(machine, { self })

step.start(input) // Exit<Step, StartError>: the machine starts
step.send(state, event) // Exit<Step, Rejection>: a public event arrives
step.settle(state, work, exit) // Step: work the host ran has ended
step.element(state, work, value) // Step: a running Stream produced a value
step.stop(state) // Step: the owner stops the machine
step.resume(snapshot) // Exit<Step, MachineSchemaDecodeError>: from a decoded snapshot
```

A host carries out each `Step` in this order: deliver `sends` with
`target.send(event)`, interrupt `stop`, publish `snapshot`, deliver `emitted`,
then run `start`. Pass `step.state` to the next call.

- A failed `Exit` from `send` means nothing happened. The event was rejected,
  either because its schema refused it or because the machine has ended, and
  the state you passed still holds.
- A machine that fails or ends still returns a `Step`. Its `exit` is set, and its
  `stop` lists every piece of work that still runs.
- Work is an `Effect`, a `Timer` (wait for `duration`, then settle with
  `Exit.void`), or a `Stream` (report each element with `element`, pull the
  next element after that step, and settle with the end of the stream).
- The state value records which entry of a state each piece of work belongs
  to. `settle` and `element` ignore the result of work whose state was exited,
  so the host never compares anything.
- `self` is the host's own target. Transitions and input mappers receive it,
  so its `send` must plan the event in a later step.

A machine that invokes a `Logic` or a child machine, or whose work requires
`Machine.MachineRuntime` or `Machine.ChildMachineRuntime`, does not compile with
`toStep`: these need a host that owns children.
