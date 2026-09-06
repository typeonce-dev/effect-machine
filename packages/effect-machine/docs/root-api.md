# Root machine API

A machine is one explicit root state. The root can own data, child topology,
both, or neither. There is no separate global context store.

## Events and transitions only

```ts
import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

const Events = Machine.events({ Open: {}, Close: {} })
const Root = Machine.state({
  initial: "Closed",
  states: { Closed: {}, Open: {} }
})
const Door = Machine.make({ root: Root, events: Events }).handle({
  states: {
    Closed: { on: { Open: (to) => to.local.Open() } },
    Open: { on: { Close: (to) => to.local.Closed() } }
  }
})
```

The root declares the default child once. No startup target, empty schema, or
resolver is needed. Structural nodes have `value: undefined` in snapshots.

## Root data and child data

```ts
const Root = Machine.state({
  fields: { title: Schema.String },
  initial: "Editing",
  states: {
    Editing: { fields: { draft: Schema.String } },
    Saving: {}
  }
})
const Events = Machine.events({ Rename: { title: Schema.String }, Save: {} })
const Editor = Machine.make({
  root: Root,
  events: Events,
  initial: (root) => root.from(() => ({ title: "Untitled" }))
}).handle({
  initialize: ({ builder, state }) => builder.from({ draft: state.title }),
  on: {
    Rename: (to) => to.self.update.from(({ event }) => ({ title: event.title }))
  },
  states: {
    Editing: { on: { Save: (to) => to.local.Saving() } }
  }
})
```

`initialize` constructs the declared child configuration. Required values must
be supplied before the machine becomes executable. Values whose schema make
input is optional can use their schema defaults. A parallel owner's initializer
constructs every required region through the typed builder.

The complete snapshot always includes the root:

```ts
// While Editing is active:
{
  path: "",
  value: { _tag: "", title: "Untitled" },
  state: {
    path: "Editing",
    value: { _tag: "Editing", draft: "Untitled" }
  }
}
```

Root handlers remain active across child transitions. Child handlers receive
their own state, typed ancestors, and the complete snapshot. `to.root.update`
addresses root data from a child. `to.self.update` addresses the handler owner.
Both replace the entire value; omitted fields are not silently retained.
Updates preserve the active topology and do not restart scoped work.

Simultaneous transitions retain conflict checking. Two parallel handlers cannot
silently overwrite the same owner. Use `.updating(owner)` to combine a selected
destination and a retained owner's value in one atomic transition.

## Schemas and reusable descriptors

Use `fields` for local data or `schema` for an existing tagged schema. They are
mutually exclusive. A schema preserves class identity, refinements, defaults,
and transformations; its tag is independent of its mount path.

```ts
class Ready extends Schema.TaggedClass<Ready>("Ready")("Ready", {
  name: Schema.String
}) {}

const Form = Machine.state({
  initial: "Idle",
  states: { Idle: {}, Ready: { schema: Ready } }
})
const Root = Machine.state({
  type: "parallel",
  states: { First: Form, Second: Form }
})
```

Each mount has its own path and lifecycle. Descriptors capture their definition
without retaining caller-owned mutable topology containers. `Machine.make`
accepts the complete descriptor as `root`; callers do not extract its internals.

`Machine.events({ Save: { title: Schema.String } })` creates a deferred
`Events.Save({ title })` constructor. The machine validates it when processing
the event. To reuse tagged classes or a tagged union, use
`Machine.eventsFromSchemas(...)`. Internal and emitted protocols have distinct
constructors with the same fields/import distinction. Public sends cannot send
internal events, and emissions do not become machine input events implicitly.

## Default initialization and explicit configuration

`initial` supplies root values while following the topology's declared child
defaults. It does not override those defaults. A structural root usually needs
no initializer.

Use the separately named `initialConfiguration` to select a complete startup
configuration, for example to start the door open:

```ts
const DoorOpen = Machine.make({
  root: Root,
  events: Events,
  initialConfiguration: (root) => root.resolve(({ target }) =>
    target.from((states) => states.Open.from())
  )
}).handle({})
```

This example uses the door root and events from the first section. Every active
value and region in an explicit configuration must be provided. `initial` and
`initialConfiguration` cannot be combined. Use `Machine.resume` when restoring
a validated snapshot, including its completion and history metadata.

## Construction, guards, and branches

A selected target supports a direct callback:

```ts
Save: (to) => to.local.Saving().from(({ event }) => ({ requestId: event.requestId }))
```

Use `.decoded(({ state }) => state)` for already decoded schema values. Use
`.resolve((context, enqueue) => ...)` when constructing child configurations or
queuing commands; its `context.target.from(...)` and `.decoded(...)` take values
and explicit child builders.

A guard runs before construction and commands:

```ts
Save: (to) => to.local.Saving()
  .guard(({ state }) => state.draft.length > 0)
  .from(({ state }) => ({ requestId: state.draft }))
```

A false guard declines this handler, allowing ancestor fallback. Guards are not
available for mandatory initial resolution or a total choice. `.none` accepts
an event without changing topology; declining and accepting have different
semantics. Named branches keep `{ target, title? }`: `target` identifies the
checked destination and `title` supplies optional presentation metadata.

Guards also apply to standalone owner updates and combined transitions:

```ts
Increment: (to) => to.self.update
  .guard(({ current }) => current.count < 10)
  .from(({ current }) => ({ ...current, count: current.count + 1 }))

Save: (to) => to.local.Saving().updating(to.root)
  .guard(({ current }) => current.draft.length > 0)
  .from(({ current }) => ({
    target: { requestId: current.draft },
    update: { ...current, attempts: current.attempts + 1 }
  }))
```

Combined `.from` returns constructor inputs for both the destination and the
complete owner replacement. `.decoded` returns their decoded values instead.
For a destination with no construction arguments, use `target: undefined`.
Both values are validated before applying either change; destination entry
observes the updated owner. Use `.resolve` for mixed construction methods,
explicit child configurations, or commands.

Reentry is a modifier before construction:

```ts
Retry: (to) => to.local.Saving().reenter()
  .from(({ event }) => ({ requestId: event.requestId }))

Refresh: (to) => to.none.reenter()

Choose: (to) => to.branches({
  saving: { target: to.local.Saving() },
  idle: { target: to.local.Idle() }
}).reenter().resolve(({ state, select }) =>
  state.retry ? select.saving.from({ requestId: state.requestId }) : select.idle.from()
)
```

`.reenter()` restarts the handler source. It composes with `.updating`, `.guard`,
`.from`, `.decoded`, and `.resolve` wherever reentry is supported. Apply it to
the whole named-branches builder, whose individual targets describe topology.
Migrate `.resolve(callback, { reenter: true })` to `.reenter().resolve(callback)`;
remove `{ reenter: false }`. `to.self.update` retains the source lifecycle and
does not expose `.reenter()`.

## Completion and history

A compound root returns its completed direct workflow's output when that child
has no `onDone` handler. A child with `onDone` first handles its completion.
Nested compound states retain statechart completion rules: an arbitrary
completed descendant does not make every ancestor final. Parallel roots
complete when all required regions complete.

Restoring history beneath the root preserves current root data. Restoring the
root's own history can restore root-owned data. History fallback builders must
construct a complete configuration containing the history owner.

## Observation and testing

- `MachineRef.state` reads the complete logical root snapshot.
- `MachineRef.snapshot` includes runtime status and completion information.
- `MachineAtom.result` retains asynchronous startup, failure, and the successful
  logical snapshot. `MachineAtom.snapshot` exposes the runtime snapshot.
- `AtomMachine.select` selects an optional value; `selectSnapshot` selects an
  optional subtree. Child inactivity remains `Option.none()`.
- `MachineState` renders a typed path in React. `createMachineContext(factory)`
  owns a separate machine per Provider without subscribing the Provider to it.

The Atom bridge and child bridge no longer expose `.state`; use `.result` or a
path selector. The core `MachineRef.state` contract remains available.

`MachineTest.run` and `MachineTest.probe` accept the same public event inputs as
production sends, including deferred constructors. Traces and acknowledgements
record the decoded event that was processed, including ignored events.

## Migration

Replace `Machine.states(tree)` and `Machine.make({ states: States.states })`
with one `Machine.state({ initial, states: tree })` descriptor and
`Machine.make({ root })`. Move the old root-level handler map under
`handle({ states: ... })`; place machine-wide behavior directly in `handle`.
Use root `fields` to replace a wrapper state introduced only to carry shared data.
Use `Machine.Snapshot<typeof root>` for the complete logical snapshot. `Machine.StateAccessors` replaces the former `Machine.DefinedStates`
helper interface; it exposes paths and projections without a public state map.

Replace schema arguments to `Machine.events`, `internalEvents`, and
`emittedEvents` with field records, or use their explicit `FromSchemas`
constructors. Replace old Atom `.state` reads with `.result`. Use
`EmittedEvent`, `EmittedEvents`, `EmittedEventOf`, and `SchemaLessStateAnnotations` in place
of the removed deprecated type aliases.

Encoded snapshots now use version 2 and include the root at path `""`.
Version 1 payloads must be explicitly migrated; the decoder rejects them.
