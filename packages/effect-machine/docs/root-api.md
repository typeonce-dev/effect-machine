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
const targets = Machine.targets(Root)
const Door = Machine.make({ root: Root, events: Events }).handle({
  states: {
    Closed: { on: { Open: { target: targets.root.Open } } },
    Open: { on: { Close: { target: targets.root.Closed } } }
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
const targets = Machine.targets(Root)
const Editor = Machine.make({
  root: Root,
  events: Events,
  initial: (root) => root.from(() => ({ title: "Untitled" }))
}).handle({
  initialize: ({ builder, state }) => builder.from({ draft: state.title }),
  on: {
    Rename: { update: targets.root, from: ({ event }) => ({ title: event.title }) }
  },
  states: {
    Editing: { on: { Save: { target: targets.root.Saving } } }
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
their own state, typed ancestors, `root`, and the complete snapshot.
`update: targets.root` addresses root data from a child. An explicit descendant
reference addresses a valued handler owner or retained ancestor.
Both replace the entire value; omitted fields are not silently retained.
Updates preserve the active topology and do not restart scoped work.

Simultaneous transitions retain conflict checking. Two parallel handlers cannot
silently overwrite the same owner. Use `{ target, update }` to combine a selected destination and a retained
owner's value in one atomic transition.

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

Ordinary transitions declare their destination inline. `from` constructs schema
make input; `decoded` returns an already decoded value. Omit construction only
when the selected state can be constructed without arguments.

```ts
Save: {
  target: targets.root.Saving,
  guard: ({ state }) => state.draft.length > 0,
  from: ({ state }) => ({ requestId: state.draft })
}
```

A false guard declines the handler and allows ancestor fallback. `{ none: true }`
accepts an event without changing topology. Initial entry and total choices
cannot decline. `reenter: true` explicitly restarts the handler source; a value
update alone retains its lifecycle and cannot request reentry.

Use a branch group in `make` for conditional selection, commands, or explicit
nested construction. The resolver receives constructors derived from that
exact declaration, so its result cannot introduce another destination.

```ts
// In make:
branches: {
  choose: {
    saving: { target: targets.root.Saving, title: "Save changes" },
    idle: { target: targets.root.Idle }
  }
}

// In handle:
Choose: {
  branches: "choose",
  resolve: ({ event, select }) => event.save
    ? select.saving.from({ requestId: event.requestId })
    : select.idle.from()
}
```

Declare `declinable: true` if a resolver may return `decline()`. Guards and
resolvers must remain synchronous and deterministic.

An owner update replaces its entire value. A combined transition constructs
both values atomically:

```ts
Save: {
  target: targets.root.Saving,
  update: targets.root,
  from: ({ root, event }) => ({
    target: { requestId: event.requestId },
    update: { ...root, attempts: root.attempts + 1 }
  })
}
```

Destination entry sees the updated owner. Use a named branch with the same
`{ target, update }` declaration for nested construction or mixed methods:
`select.saved.from(payload).update.decoded(ownerValue)`.

All destination references are paths derived by `Machine.targets(Root)`.
`target` selects a descendant; `initial` enters a compound or parallel subtree
using its declared initialization; `history` restores a history reference.
`update: targets.root` changes root data while preserving active children.
There is no transition operation that replaces an arbitrary full root
configuration. Use explicit branches to keep every possible destination visible.

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
