# @typeonce/effect-machine-react

React ownership and typed state rendering for
[`@typeonce/effect-machine`](../effect-machine/README.md).

```tsx
import { createMachineContext, MachineState } from "@typeonce/effect-machine-react"
import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { AuthMachine } from "./auth-machine"

const Auth = createMachineContext(AtomMachine.factory(AuthMachine))

function AuthRoute({ input }: Props) {
  return (
    <Auth.Provider input={input}>
      <AuthForm />
    </Auth.Provider>
  )
}

function AuthForm() {
  const machine = Auth.useMachine()
  return (
    <MachineState machine={machine} path="Editing" inactive={null}>
      {({ value }) => <EmailField email={value.email} />}
    </MachineState>
  )
}
```

Each Provider creates an independent machine in the current Atom registry,
including when two Providers receive equal inputs. Supply an Atom
`RegistryProvider` at the application boundary. Bind Effect services through
`AtomMachine.runtime(...)` before creating a factory when the machine needs them.

The Provider owns the reference without subscribing to state changes.
`MachineState` subscribes to its typed path and infers the callback snapshot
without suspending. Server rendering and hydration render the machine's planned
startup snapshot, and the same tree then receives live snapshots, so hydrated
form inputs keep their DOM nodes, text, and focus. Before any snapshot exists it
renders `pending`; inactive paths render `inactive` (both null by default).
Failures propagate to the nearest error boundary. Keep the owner above any
Suspense boundary used by custom `useAtomSuspense` readers.

`MachineState` also accepts a child bridge. Its paths and snapshot are the
child's, and `inactive` also renders while the state that owns the child is not
active:

```tsx
<MachineState machine={machine.child(QuantityChild)} path="" inactive={null}>
  {(snapshot) => <NumberField value={snapshot.value.quantity} />}
</MachineState>
```

Input is startup-only. Send an event to update a running workflow, or change the
Provider's React `key` to start a new one. Machines without input have a Provider
without an `input` prop.

Per-owner capabilities, such as a router-bound navigation service, are layers,
never input. Declare a second, `Layer`-typed factory parameter, and the Provider
requires a `layer` prop of that type. Like input, the layer is read once when
the Provider mounts:

```tsx
const SignIn = createMachineContext(
  (input: SignInInput, navigation: Layer.Layer<Navigation>) =>
    AtomMachine.bind(Atom.runtime(Layer.provideMerge(navigation, AppLayer)))
      .make(SignInMachine, input)
)

<SignIn.Provider input={input} layer={navigationLayer(useRouter())}>
  <SignInForm />
</SignIn.Provider>
```

`useMachineAtom(() => makeMachine(input))` remains available for custom owners.
Use `AtomMachine.select`, `selectSnapshot`, and `matches` for custom granular
subscriptions, and read them with `useMachineResult(atom)`: like `MachineState`,
it serves the planned value during hydration and keeps the last success while
the machine starts, where `useAtomValue` would return `Initial` again. Derive narrower projections with `Atom.family`, `Atom.mapResult`,
and `Atom.withEquality` rather than hook options. Read `.result` for the whole logical snapshot or `.snapshot` for
runtime status; the bridge has no separate `.state` projection.

See the [React guide](../effect-machine/docs/effect-atom-react.md) for events,
services, child machines, and registry-owned families.
