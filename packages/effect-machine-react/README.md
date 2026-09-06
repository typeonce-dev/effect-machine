# @typeonce/effect-machine-react

React ownership and typed state rendering for
[`@typeonce/effect-machine`](../effect-machine/README.md).

```tsx
import { createMachineContext, MachineState } from "@typeonce/effect-machine-react"
import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { Suspense } from "react"
import { AuthMachine } from "./auth-machine"

const Auth = createMachineContext(AtomMachine.factory(AuthMachine))

function AuthRoute({ input }: Props) {
  return (
    <Auth.Provider input={input}>
      <Suspense fallback={<Loading />}>
        <AuthForm />
      </Suspense>
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
`MachineState` subscribes to its typed path and infers the callback snapshot.
Inactive paths render `inactive` (null by default); startup suspends and failures
propagate to the nearest error boundary. Keep the owner above Suspense.

Input is startup-only. Send an event to update a running workflow, or change the
Provider's React `key` to start a new one. Machines without input have a Provider
without an `input` prop.

`useMachineAtom(() => makeMachine(input))` remains available for custom owners.
Use `AtomMachine.select`, `selectSnapshot`, and `matches` for custom granular
subscriptions. Read `.result` for the whole logical snapshot or `.snapshot` for
runtime status; the bridge has no separate `.state` projection.

See the [React guide](../effect-machine/docs/effect-atom-react.md) for events,
services, child machines, and registry-owned families.
