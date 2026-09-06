# Effect Atom and React

React code should own one stable machine atom, pass it through props or
Context, and subscribe in the descendants that render machine state. Keep the
machine definition free of React dependencies.

Read the [Effect Machine agent guide](./agent-guide.md) for statechart
modeling, transitions, services, and testing.

## Recommended folder structure

```text
src/
├── context/
│   └── auth-machine-context.tsx  # React ownership and distribution
├── lib/
│   ├── atom-runtime.ts           # Shared bound AtomMachine runtime
│   └── services/
└── machines/
    └── auth-machine.ts           # States, events, and behavior
```

`machine.ts` owns the workflow. A Context module only creates and distributes
the machine atom. State-slot components decide which state paths they render.

Bind service-backed machines once at the application runtime:

```ts
import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { Atom } from "effect/unstable/reactivity"
import { AppLayer } from "./app-layer"

const atomRuntime = Atom.runtime(AppLayer)

export const MachineAtoms = AtomMachine.bind(atomRuntime)
```

Service-free machines can use `AtomMachine.make` directly.

## Own a machine in one React subtree

Create a context from a factory. Each Provider owns a fresh bridge in its current
Atom registry; it does not subscribe to state changes.

```tsx
import { createMachineContext } from "@typeonce/effect-machine-react"
import { AuthMachine } from "../machines/auth-machine"
import { MachineAtoms } from "../lib/atom-runtime"

export const Auth = createMachineContext(MachineAtoms.factory(AuthMachine))
export const useAuthMachine = Auth.useMachine

function AuthRoute({ input, attemptId }: Props) {
  return (
    <Auth.Provider key={attemptId} input={input}>
      <Suspense fallback={<Loading />}>
        <AuthCard />
      </Suspense>
    </Auth.Provider>
  )
}
```

Input is startup-only. Send events to update the existing workflow; change the
Provider's React key to create a new one. Keep the Provider above Suspense so
suspension does not discard the owner. Supply an Atom RegistryProvider at the
application boundary. The same factory used by two Providers creates isolated
machines, even when their inputs are equal.

`useMachineAtom(() => makeMachine(input))` remains available for custom owners.
It mounts the reference after commit without reading `result` or `snapshot`.

## Render state-owned data

Render a typed path in the smallest component that needs it:

```tsx
import { MachineState } from "@typeonce/effect-machine-react"

function EditingFields() {
  const machine = useAuthMachine()
  return (
    <MachineState machine={machine} path="Editing" inactive={null}>
      {({ value }) => <EmailField email={value.email} />}
    </MachineState>
  )
}
```

`MachineState` subscribes only its renderer. The path determines the callback's
snapshot type. Startup suspends, failures reach the nearest error boundary,
and an inactive path renders `inactive` (null by default).

For custom hooks, `useAtomSuspense(AtomMachine.selectSnapshot(machine, path)).value`
returns an Option of the selected snapshot.

`AtomMachine.select` returns the selected state value.
`AtomMachine.selectSnapshot` also retains the selected state's child topology.
Both return `Option.none()` while the path is inactive. Do not replace that
absence with an empty string, `null`, or a global boolean.

Repeated calls with the same machine and path return the same atom, so path
selection is safe during render without `useMemo`. Equal selected values do not
notify the component.

Nested paths keep the same ownership:

```tsx
function PasswordField() {
  const machine = useAuthMachine()
  const password = useAtomSuspense(
    AtomMachine.select(machine, "Editing.Password")
  ).value

  return Option.match(password, {
    onNone: () => null,
    onSome: ({ password }) => <input type="password" value={password} />
  })
}
```

Place independent subscriptions in independent descendants:

```tsx
function AuthCard() {
  return (
    <>
      <EditingFields />
      <VerificationFields />
      <FailureMessage />
      <SubmitButton />
    </>
  )
}
```

Atom granularity cannot isolate hooks that all live in `AuthCard`. Any selected
change rerenders the component that called the hook.

## Send without subscribing

Use the writable atom directly:

```tsx
import { useAtomSet } from "@effect/atom-react"

function SubmitButton() {
  const machine = useAuthMachine()
  const send = useAtomSet(machine.send)

  return (
    <button onClick={() => send({ _tag: "Submitted" })}>
      Continue
    </button>
  )
}
```

`useAtomSet` mounts the writable atom and does not subscribe the component to
its value.

## Query concrete event acceptance

`AtomMachine.can` turns one concrete event input into a reusable machine
projection. Declare the projection once, then apply it to the React-owned
machine. Repeated applications to the same machine return the same atom:

```tsx
import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { useAtomSet, useAtomSuspense } from "@effect/atom-react"
import { AuthEvents } from "../machines/auth-machine"

const submitAllowed = AtomMachine.can(AuthEvents.Submitted())

function SubmitButton() {
  const machine = useAuthMachine()
  const canSubmit = useAtomSuspense(submitAllowed(machine)).value
  const send = useAtomSet(machine.send)

  return (
    <button
      disabled={!canSubmit}
      onClick={() => send(AuthEvents.Submitted())}
    >
      Continue
    </button>
  )
}
```

Startup still suspends, startup and runtime failures reach the error boundary,
and invalid event input for an active machine remains a
`MachineSchemaDecodeError`. Done and stopped machines return `false`.

When acceptance depends on a changing payload, project an event atom instead:

```ts
import { Atom } from "effect/unstable/reactivity"

const submitEvent = Atom.map(draftAtom, (draft) =>
  AuthEvents.Submitted({ draft }))

const submitAllowed = AtomMachine.can(submitEvent)
```

Changes to `draftAtom` recompute acceptance. The event atom contains the event
input itself rather than an `AsyncResult`.

## Whole-result and custom selections

Reading the full result is correct when a component renders the complete
machine state:

```tsx
function AuthScreen() {
  const machine = useAuthMachine()
  const state = useAtomSuspense(machine.result).value

  return <MachineSummary snapshot={state} />
}
```

That component rerenders for every result change. Current
`@effect/atom-react` does not select from the successful value in
`useAtomSuspense`. Until it does, use typed path selectors for state-owned UI,
or declare a custom derived atom once in a strongly owned scope. Do not create
a fresh derived atom on every render.

## Share a keyed machine outside one React owner

`AtomMachine.family` is for registry-owned machines that unrelated consumers
find by startup input. It is not the default for one React-owned workflow.

```ts
export const processAtoms = MachineAtoms.family(ProcessMachine, {
  atoms: {
    details: AtomMachine.select("Processing"),
    ready: AtomMachine.matches("Ready"),
    send: (machine) => machine.send
  }
})
```

Consumers use the input as the shared identity key:

```tsx
const details = useAtomSuspense(processAtoms.details(input)).value
const send = useAtomSet(processAtoms.send(input))
```

Each public projection retains its private machine owner. Keeping only
`details(input)` or `send(input)` is safe. Do not return a weakly held composite
scope and retain only one field from it.

Family keys use Effect `Equal` and `Hash` semantics. Keep them immutable. If a
changing value should update one running workflow, model it as an event instead
of changing the family key.

## Module-owned machines

A no-input machine may intentionally have one module-owned identity:

```ts
export const CounterMachineAtom = MachineAtoms.make(CounterMachine)
export const CounterStateAtom = AtomMachine.select(CounterMachineAtom, "Count")
```

Every consumer using the same `AtomRegistry` reaches the same running machine.
Different registries still run independent instances.

## Child machines

Direct child selectors follow the active child and preserve inactivity:

```tsx
const editor = machine.child(Editor)
const editing = useAtomSuspense(
  AtomMachine.selectSnapshotChild(editor, "Editing")
).value
```

An inactive child or path returns `Option.none()`. Re-entry follows the
replacement child instance.

Use `AtomMachine.familyChild` when a parent owns a runtime-sized set of keyed
children:

```ts
const Plant = Machine.childFamily(PlantMachine)

export const plantAtoms = AtomMachine.familyChild(CentralMachineAtom, {
  child: (plantId: string) => Plant(plantId),
  atoms: {
    broken: AtomMachine.matchesChild("Broken"),
    state: (plant) => plant.result,
    send: (plant) => plant.send
  }
})
```

## Registry and rendering semantics

A `MachineAtom` identifies one machine per `AtomRegistry`. Passing the same
machine atom through two registry providers creates two independent runtimes.
Unmounting a React owner releases its mount. The registry stops the machine
after its final subscription and configured idle retention expire.
`registry.dispose()` stops it immediately.

`useMachineAtom` does not start a machine during server rendering because
React effects do not run on the server. Reading a machine atom during server
render follows `@effect/atom-react` server-read behavior, so choose an explicit
client boundary when server startup would be undesirable.
