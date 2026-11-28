## Write a host for a new runtime

Applications run machines with `LocalMachine`, `AtomMachine`, or
`ClusterMachine`. Use `Machine.toStep` only to run a machine somewhere these
hosts do not reach, such as a UI store that keeps the state itself.

`Machine.toStep(machine, options)` returns pure functions. They run nothing and
call no user code: each one returns the next state as a value, with the
commands to carry out and the work to stop and to start.

```ts
const step = Machine.toStep(machine, { self, parent, children })

step.start(input) // Exit<Step, StartError>: the machine starts
step.send(state, event) // Exit<Step, Rejection>: a public event arrives
step.settle(state, work, exit) // Step: work ended, or could not start
step.element(state, work, value) // Step: a running Stream produced a value
step.report(state, work, snapshot) // Step: a running Logic or child machine reached a state
step.stop(state) // Step: the owner stops the machine
step.resume(snapshot, progress) // Exit<Step, MachineSchemaDecodeError>: from a decoded snapshot
```

The options are what the machine needs of its host:

- `self` is the host's own target. Transitions and input mappers receive it,
  so its `send` must plan the event in a later step.
- `parent` is the target of the owner, for a machine that declares a parent.
  It is required when the parent is.
- `children` are the operations on the children of the machine, which the host
  owns: `spawn`, `spawnLogic`, `sendTo`, and `stop`. They are required when work
  requires `Machine.MachineRuntime` or `Machine.ChildMachineRuntime`. Without
  them, every operation on children fails the machine with `ProcessLocalError`.

A host carries out each `Step` in this order: carry out `commands`, interrupt
`stop`, publish `snapshot`, deliver `emitted`, then start `start`. Pass
`step.state` to the next call.

- A failed `Exit` from `send`, `start`, or `resume` means nothing happened. An
  event is rejected because its schema refused it or because the machine has
  ended, and the state you passed still holds.
- A machine that fails or ends still returns a `Step`. Its `exit` is set, and its
  `stop` lists every piece of work that still runs.
- `commands` are `Send` (call `target.send(event)`), `SendToChild`, and
  `StopChild`. A command to a child names the running `Logic` or child machine
  it selects as `work`. A stopped one no longer runs, and reports nothing. With
  no `work`, the command is for a child that work spawned.
- `snapshot` and `microsteps` are built when first read. `event` is the event
  the step planned, for inspection.

Work is data. The host evaluates each piece as it starts it, in order, with the
accessor of its kind. Each accessor calls the source and the input mapper at
most once and returns an `Exit`:

- `Effect`: `work.effect()`, then run it and settle its `Exit`.
- `Timer`: `work.duration()` holds how long to wait, then settle with
  `Exit.void`. When the input names no duration, the inner `Exit` fails: settle
  with it at once, as a timer of zero duration ends. `work.effect()` is the same
  timer as an Effect, for a host whose timers wait on fibers.
- `Stream`: `work.stream()`. Report each element with `element`, pull the next
  element after that step, and settle with the end of the stream.
- `Logic`: `work.logic()`. Run `initial` and `run` with contexts of the host,
  `report` each state it sets, and settle with the end of `run`.
- `Child`: `work.input()` holds the arguments of its `start`. Host
  `work.child.machine` with `Machine.toStep` again, with this machine as its
  `parent`, `report` its snapshots, and settle with its `exit`.

A failed accessor means the work could not start: settle the work with that
`Exit` at once. The machine fails and runs no more work, so do not start the rest
of the step.

The state value records which entry of a state each piece of work belongs to.
`settle`, `element`, and `report` ignore work whose state was exited, so the host
never compares anything. Pass back the work object that a step listed: work is
matched by identity, so a result from before a `resume` is ignored too.

A durable host passes `progress` to `resume`: `{ path, id, status }` for each
invocation of an active state that `"Ended"` or is still `"Running"`. Ended work
is not listed again. Running work is not in `start`; find it in `step.running`
and settle it when it ends. To keep that progress, read `step.exited` and
`step.entered`, the paths of the states a step left and entered, without
building a snapshot: forget what you stored for the work of an exited state.
A result that is ignored returns a step whose `state` is the state you passed.
`ClusterMachine` is such a host.

A host that runs only some kinds of work refuses the others at compile time:
`machine: M & Machine.MachineStep.Supported<M, "Stream">`.
