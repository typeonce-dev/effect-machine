# Root machine API

A machine has one root state. It can own data, child topology, both, or neither.
`Machine.state` declares that structure; `Machine.make` declares protocols and
reusable sources; `.handle` supplies initialization and behavior.

## Startup input and state data

```ts
import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

const Root = Machine.state({
  fields: { locale: Schema.String },
  states: {
    Loading: { fields: { documentId: Schema.String } },
    Ready: {}
  }
})
const targets = Machine.targets(Root)
const Events = Machine.events({
  Loaded: {},
  Reload: { locale: Schema.String, documentId: Schema.String }
})
const Document = Machine.make({
  root: Root,
  events: Events,
  input: Schema.Struct({ locale: Schema.String, documentId: Schema.String })
}).handle({
  root: ({ input }) => ({ locale: input.locale }),
  initial: {
    target: targets.root.Loading,
    data: ({ input }) => ({ documentId: input.documentId })
  },
  on: {
    Reload: {
      target: targets.root,
      input: ({ event }) => ({ locale: event.locale, documentId: event.documentId }),
      reenter: true
    }
  },
  states: {
    Loading: { on: { Loaded: { target: targets.root.Ready } } }
  }
})
```

Start with `Machine.start(Document, { locale: "en", documentId: "intro" })`.
Root construction runs before its initial child construction. Both receive the
same validated input. `documentId` belongs only to Loading; it need not be stored
in root data. Input is not retained as a reset value on the machine or snapshot.

Only the root's initial callbacks receive machine input. Nested initial callbacks
receive their owning state, ancestors, root, and lifecycle event. Pass any needed
values through the nested state's data. Input is not an entry/exit capability.

For a parallel root, every required region constructor receives input:

```ts
initial: {
  Documents: ({ input }) => ({ folder: input.folder }),
  Connection: ({ input }) => ({ endpoint: input.endpoint })
}
```

Structural regions require no data. Schema constructor defaults can supply
optional region data. Compound handlers declare one direct initial child with
`initial: { target, data }`; each compound has its own initial declaration.
There is no `initialConfiguration` or initializer in `make`.

## Root targets and updates

`{ target: targets.root, input: ... }` reconstructs root data and follows its
initial declarations using fresh input. Input is required exactly when it is
required by `Machine.start`. Machines without input omit it. Root targets reject
`data`, `decoded`, and explicit child construction.

Targeting root retains its lifecycle unless it is reentered. Put a machine-wide
reset handler at root and use `reenter: true` to exit and enter root as well as
its descendants. Reentry restarts work owned by the exited states. Without
reentry, retained root work continues; it does not automatically acquire new
construction values. Ordinary transition conflict and lifecycle rules still apply.
This does not create a new machine reference or discard history records.

`{ update: targets.root, data: ... }` instead replaces root's complete value,
retaining its active children and running work. It takes no input and does not
run initial constructors. Other source/ancestor updates follow the same rules.

## Inline and named construction

Ordinary transitions stay inline:

```ts
Load: {
  target: targets.root.Loading,
  data: ({ event }) => ({ documentId: event.documentId })
}
```

Targeting a compound or parallel state follows its initial declarations. Event
transitions use `target`, never `initial`. `initial` names only handler startup
edges. `history` restores a declared history reference; `none: true` accepts an
event without changing its target configuration.

Declare branch topology in `make` when a resolver chooses an outcome, builds an
explicit subtree, or enqueues commands:

```ts
branches: {
  open: {
    checkout: { target: targets.root.Checkout },
    unchanged: { none: true }
  }
}
```

The resolver calls a constructor bound to that declaration:

```ts
Open: {
  branches: "open",
  resolve: ({ event, select }) => event.open
    ? select.checkout({
      data: { cartId: event.cartId },
      states: { Review: { data: { total: event.total } } }
    })
    : select.unchanged()
}
```

Objects contain computed values, not nested constructor callbacks. `data` is
schema make input; `{ decoded: true, data: value }` supplies the decoded type.
Both paths validate and report typed schema failures before committing changes.
The decoded flag applies only to its own node. Structural nodes reject data.

Omitting `states` follows declared initial children. Explicit compound
construction selects exactly one child. Entering an inactive parallel subtree
requires every region. Source-local parallel construction can select a single
region while retaining its active siblings, preserving the existing scope rules.
Names under `states` cannot collide with construction metadata.

Declared branch targets remain inspectable without executing a resolver.
Dynamically selected descendants are visible after resolution; this API does not
add static analysis of resolver bodies.

## Retained-owner updates

An inline combined transition keeps `target` and `update` references separate:

```ts
Save: {
  target: targets.root.Checkout.Saving,
  update: targets.root.Checkout,
  data: ({ event }) => ({
    target: { requestId: event.requestId },
    update: { cartId: event.cartId }
  })
}
```

For the same pair declared as a named branch, construct both in one call:

```ts
select.saved({
  data: { requestId: event.requestId },
  update: { data: { cartId: event.cartId } }
})
```

`update` is required only for a branch declaring an owner update. It is not an
arbitrary nested-state operation. The owner must be active and retained across
the transition. Both complete values validate before either is committed.

## History and lifecycle

History fallback uses a bound function with the same node object format:

```ts
history: {
  recent: {
    default: ({ target }) => target({
      states: {
        Checkout: {
          data: { cartId: "new" },
          states: { Review: { data: { total: 0 } } }
        }
      }
    })
  }
}
```

A fallback must explicitly construct a complete tree containing its owner,
including required ancestors and parallel siblings. Its root data is state data,
not startup input. `Machine.resume` restores a validated snapshot without rerunning
startup constructors.

`guard` declines before construction. A resolver may return `decline()` only with
`declinable: true`. Effect, Stream, timer, logic, child invocation, completion,
entry/exit, and required outcome channels retain their existing contracts.

## Migration

- Root initial constructors can read `input`; remove root fields used only to
  forward that input to the initial child.
- Replace event `{ initial: reference, data }` with `{ target: reference, data }`.
- Replace `select.branch.from(value)` with `select.branch({ data: value })`.
- Replace `.decoded(value)` with `({ decoded: true, data: value })`.
- Replace child callbacks with `states: { Child: { data, states } }`.
- Replace `.update.from(value)` chaining with `update: { data: value }` inside
  the same selector call.
- Replace history fallback chains with `target({ states: ... })`.
