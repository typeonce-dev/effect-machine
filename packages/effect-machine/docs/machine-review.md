# Effect Machine implementation review

Use this review after a machine and its UI adapter have been implemented. Look
for modeling mistakes, redundant API usage, and logic that escaped the machine.
Do not force a change when the current ownership is intentional.

Read the [Effect Machine agent guide](./agent-guide.md) for statechart modeling
and [Effect Atom and React patterns](./effect-atom-react.md) for integration
patterns.

Run the recommended rules from
[`@typeonce/oxlint-plugin-effect-machine`](../../oxlint-plugin/README.md) before
the manual review. They catch provable duplicate invocation identities,
asynchronous work, browser access, nondeterminism, and redundant resolvers in
direct same-module machine definitions. Continue with this review for
cross-module ownership and architectural questions that syntax alone cannot
answer.

## Review the responsibility boundaries

Use this split when deciding where code belongs:

| Layer | Owns |
| --- | --- |
| Machine | State, transitions, workflow decisions, effect lifetimes, and service execution |
| Atoms | Reactive selection, projections, and keyed machine lookup |
| Component | Rendering and translating user interaction into domain events |
| `RegistryProvider` | An optional Atom registry ownership boundary |

If a component coordinates a workflow, an atom performs business work, or a
provider has no ownership purpose, inspect that code more closely.

## Remove identity resolvers

A target that supports default construction does not need a resolver whose only
job is returning `target.from()`.

```ts
// Redundant
const handlers = {
  Start: (to) =>
    to.full.Running().resolve(({ target }) => target.from())
}

// Preferred
const handlers = {
  Start: (to) => to.full.Running()
}
```

This applies to schema-less states and schemas whose constructor fields are all
optional or defaulted. The type checker rejects the shorter form when the
target needs data.

Keep `.resolve(...)` when it uses handler context, constructs state data,
updates a retained owner, chooses a branch, declines a transition, or enqueues
commands. For resolver-free reentry, use `.reenter()`:

```ts
const handlers = {
  Refresh: (to) => to.local.Ready().reenter()
}
```

Review check: search for `.resolve(...)` callbacks that only return an empty
`target.from()` and remove the callback.

## Choose React ownership or keyed family lookup

Use `useMachineAtom` when one React subtree owns the workflow, including a
machine with startup input:

```tsx
const machine = useMachineAtom(() => machineAtoms.make(processMachine, input))
```

Pass the stable machine through props or Context. Startup input is captured
once. Send an event to change the running workflow, or change the owner's React
key to replace it.

Use `AtomMachine.family` when unrelated consumers must find one shared machine
by its startup input. Effect Atom keeps a family value for an equal key while
that returned value is reachable. Current runtimes may hold family values
through `WeakRef`. Retaining one field from a composite family value does not
retain the composite itself:

```ts
// Unsafe when consumers retain only stateAtom or sendAtom
const processScope = Atom.family((input: ProcessInput) => {
  const machine = machineAtoms.make(processMachine, input)
  return {
    stateAtom: AtomMachine.select(machine, "process"),
    sendAtom: machine.send
  }
})
```

`AtomMachine.family` returns direct atom families whose atoms retain the
private machine bridge:

```ts
export const processAtoms = machineAtoms.family(processMachine, {
  atoms: {
    state: AtomMachine.select("process"),
    send: (machine) => machine.send
  }
})

const stateAtom = processAtoms.state(input)
const sendAtom = processAtoms.send(input)
```

No component `useMemo` is needed. The registry retains the public atom while a
hook subscribes to it, and that atom retains the machine owner. Equal inputs
use Effect `Equal` and `Hash` semantics and select the same family value.

For a no-input machine, use one module-level bridge or `useMachineAtom` in the
owning React subtree. Do not add an unused family key.

Review check: search for composite `Atom.family` values that own a machine,
`useMemo` around family lookup, repeated input propagation through one React
subtree, and component-local calls to `machineAtoms.make` without a stable
owner. Choose `AtomMachine.family` only when consumers need shared keyed
lookup.

## Justify each `RegistryProvider`

Effect Atom hooks use a shared default registry when no provider is present.
Do not add `RegistryProvider` automatically.

Keep a provider when the subtree intentionally needs its own registry. Common
reasons include:

- the same atom or machine descriptors must represent independent instances in
  separate subtrees;
- the subtree owns registry disposal;
- server rendering or hydration requires a request-local registry;
- the registry needs initial values, custom scheduling, or custom idle
  settings.

Without one of those requirements, the default registry is enough:

```tsx
// A shared application instance can use the default registry.
export function App() {
  return <ProcessScreen />
}
```

Remember that adding or nesting a provider changes identity. The same atom
descriptor stores separate state in each registry, so an unnecessary provider
can split a machine that consumers expected to share.

Review check: for every `RegistryProvider`, state which registry boundary it
creates and why. Remove it when there is no deliberate boundary.

## Keep workflow logic in the machine

The machine owns business flow. Components render selected state and send
domain events. Atoms adapt machine state for reactive consumers. Neither layer
should coordinate the workflow.

The following component owns too much:

```tsx
const submit = async () => {
  send(OrderEvents.SubmitStarted())
  const order = await api.submitOrder(form)
  analytics.track("order submitted", { orderId: order.id })
  send(OrderEvents.SubmitSucceeded({ order }))
}
```

Model `Submit` as the component-facing event. Let a machine state own the work
and its lifetime:

```ts
machine.handle({
  Editing: {
    on: {
      Submit: (to) =>
        to.full.Submitting().resolve(({ event, target }) =>
          target.from({ order: event.order })
        )
    }
  },
  Submitting: {
    invoke: (from) =>
      from
        .effect("submit-order", ({ state }) => submitOrder(state.order))
        .onDone((to) =>
          to.full.Complete().resolve(({ output, target }) =>
            target.from({ order: output })
          )
        )
        .onFailure((to) =>
          to.full.Failed().resolve(({ error, target }) =>
            target.from({ message: String(error) })
          )
        )
  }
})
```

`submitOrder` can use Effect services for the API request and analytics. The
service implementation may live in its own module, but the machine decides
when it runs, which state owns it, what cancels it, and how success or failure
changes the workflow.

Apply the same test to browser APIs, storage, timers, analytics, navigation,
and other effects. If the result or lifetime affects machine behavior, execute
it through the machine. UI-only work such as focusing an element or measuring
layout can remain in the component when it does not participate in the domain
flow.

Review check: search components, hooks, and atom modules for service calls,
`Effect.run*`, promises, browser APIs, analytics, timers, and chains of `send`
calls. Move workflow coordination into states, transitions, and invoked work.

## Report findings

For each issue, cite the file and line, name the violated boundary, and show the
smallest correction. Distinguish a confirmed problem from a provider or
ownership choice that needs clarification. Do not rewrite correct code merely
to match an example in this guide.
