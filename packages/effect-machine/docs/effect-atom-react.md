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
import { Atom } from "effect/reactivity"
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

export const Auth = createMachineContext(({ input }: { input: AuthInput }) =>
  MachineAtoms.make(AuthMachine, input)
)
export const useAuthMachine = Auth.useMachine

function AuthRoute({ input, attemptId }: Props) {
  return (
    <Auth.Provider key={attemptId} input={input}>
      <AuthCard />
    </Auth.Provider>
  )
}
```

The factory takes one options object, and each option it declares is a
Provider prop of the same name and type. A machine without input can pass
`MachineAtoms.factory(Machine)` directly, and its Provider takes no `input`.
Input is startup-only. Send events to update the existing workflow; change the
Provider's React key to create a new one. `MachineState` does not suspend, so
the first paint needs no Suspense boundary. Custom readers that use
`useAtomSuspense` still suspend during startup; keep the Provider above their
Suspense boundary so suspension does not discard the owner. Supply an Atom
RegistryProvider at the application boundary. The same factory used by two Providers creates isolated
machines, even when their inputs are equal.

`useMachineAtom(() => makeMachine(input))` remains available for custom owners.
It mounts the reference after commit without reading `result` or `snapshot`.

## Per-owner capabilities

A router, a callback owned by a component, or another per-instance capability
is a service, never a schema field or startup input. Declare the service, let a
state invoke the work that needs it, and provide the implementation from the
React owner:

```tsx
import { Machine } from "@typeonce/effect-machine"
import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { useMachineAtom } from "@typeonce/effect-machine-react"
import { Context, Effect, Layer } from "effect"
import { Atom } from "effect/reactivity"
import { AppLayer } from "../lib/app-layer"

export class Navigation extends Context.Service<Navigation, {
  readonly push: (href: string) => Effect.Effect<void>
}>()("Navigation") {}

export const OnboardingMachine = Machine.make({
  root: Machine.state({
    states: { Editing: {}, Leaving: {}, Done: { type: "final" } }
  }),
  events: Machine.events({ Submit: {} }),
  effects: {
    navigateNext: Effect.flatMap(Navigation, (navigation) =>
      navigation.push("/onboarding/next"))
  }
}).handle({
  initial: { target: "Editing" },
  states: {
    Editing: { on: { Submit: { target: "Leaving" } } },
    Leaving: { invoke: { src: "navigateNext", onDone: { target: "Done" } } },
    Done: {}
  }
})

function OnboardingRoute() {
  const router = useRouter()
  const machine = useMachineAtom(() =>
    AtomMachine
      .bind(Atom.runtime(Layer.merge(
        AppLayer,
        Layer.succeed(Navigation, {
          push: (href) => Effect.sync(() => router.push(href))
        })
      )))
      .make(OnboardingMachine)
  )

  return <OnboardingForm machine={machine} />
}
```

The requirement stays on the machine type. Binding the machine to a runtime
without `Navigation`, such as the application-wide `MachineAtoms`, is a compile
error. Snapshots contain only schema data, so `Machine.encodeSnapshot` keeps
working, and tests substitute the capability with `Layer.mock(Navigation, ...)`.

Create the runtime inside the `useMachineAtom` factory so each owner builds it
once. `Atom.runtime` builds layers through the registry's memo map: the shared
`AppLayer` is built once per registry and reused, and each owner builds only its
own capability layer. Use `Layer.provideMerge(ownerLayer, AppLayer)` when the
owner layer itself needs application services.

To share the owner-bound machine with a subtree, declare the capability as a
`layer` option of a `createMachineContext` factory. `OnboardingMachine` has no
input, so the factory declares only `layer`:

```tsx
import { createMachineContext } from "@typeonce/effect-machine-react"

const navigationLayer = (router: Router) =>
  Layer.succeed(Navigation, {
    push: (href) => Effect.sync(() => router.push(href))
  })

export const Onboarding = createMachineContext(
  ({ layer }: { layer: Layer.Layer<Navigation> }) =>
    AtomMachine
      .bind(Atom.runtime(Layer.provideMerge(layer, AppLayer)))
      .make(OnboardingMachine)
)

function OnboardingRoute() {
  return (
    <Onboarding.Provider layer={navigationLayer(useRouter())}>
      <OnboardingForm />
    </Onboarding.Provider>
  )
}
```

The Provider requires a `layer` prop of exactly the declared `Layer` type, and
an `input` prop when the factory also declares input, as in
`({ input, layer }: { input: SignInInput; layer: Layer.Layer<Navigation> })`.
Options other than `input` and `layer` are rejected, so a capability cannot
travel under another name. A factory without a `layer` option has a Provider
without a `layer` prop. Like `input`, the layer is read once, when the Provider
mounts: a new router instance does not rebuild the running machine. Change the
Provider's React `key` to create a new owner with a new layer. Binding still
checks the machine's requirements, so a layer type that omits `Navigation` is a
compile error.

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
snapshot type. It does not suspend: until the machine has a snapshot it renders
`pending`, and an inactive path renders `inactive` (both null by default).
Startup and runtime failures reach the nearest error boundary. Once a snapshot
has rendered, the renderer keeps it while the machine is still starting, for
example while a bound runtime layer builds after hydration.

`MachineState` also renders a child machine. Pass the child bridge; paths and
the snapshot are then the child's, and `inactive` also renders while the state
that owns the child is not active:

```tsx
<MachineState machine={machine.child(QuantityChild)} path="" inactive={null}>
  {(snapshot) => <NumberField value={snapshot.value.quantity} />}
</MachineState>
```

For custom hooks, `useMachineResult(atom)` reads any result atom, such as
`AtomMachine.selectSnapshot(machine, path)`, `matches`, or `can`, with the same
rendering semantics as `MachineState`: it does not suspend, serves the planned
value during server rendering and hydration, and keeps the last `Success` while
the machine is still starting. Prefer it to `useAtomValue`, which returns
`Initial` again after hydration and makes the renderer replace hydrated markup.
`useAtomSuspense(AtomMachine.selectSnapshot(machine, path)).value` returns an
Option of the selected snapshot for readers inside a Suspense boundary.

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

A write to a ready machine is processed inside the event handler, and work
invoked by the entered state starts there too. A browser call that requires
user activation, such as `window.open`, `navigator.clipboard.writeText`, or
`HTMLMediaElement.play`, can therefore run in the first step of the invoked
Effect. A write held while the machine is still starting is delivered later,
outside the user's gesture.

Writes made while the machine is still starting, for example while a bound
`Atom.runtime` layer is building after hydration, are held and delivered in
write order once the machine is ready. The write result stays waiting until
the event is delivered and fails with the startup error if startup fails.
Writes after the machine stopped or completed fail with `StoppedError`. The
same applies to `stop` and to child `send` and `stop`; a child command fails
with `ChildNotActiveError` when the state that owns the child is not active.

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
import { Atom } from "effect/reactivity"

const submitEvent = Atom.map(draftAtom, (draft) =>
  AuthEvents.Submitted({ draft }))

const submitAllowed = AtomMachine.can(submitEvent)
```

Changes to `draftAtom` recompute acceptance. The event atom contains the event
input itself rather than an `AsyncResult`.

`can` is `true` whenever the active configuration selects a transition. A
`{ none: true }` branch is a selected transition: it accepts the event without
changing state. A resolver that falls back to a `none` branch therefore keeps
the button enabled:

```ts
// Before: an incomplete form still accepts Submitted, so `can` is true.
// In make: branches: { submit: { review: { target: "Reviewing" }, incomplete: { none: true } } }
Submitted: {
  branches: "submit",
  resolve: ({ state, select }) =>
    state.email.length > 0 ? select.review() : select.incomplete()
}
```

When the event must be refused, decline it. Use `guard` for an ordinary
transition, or `declinable: true` with `decline()` in a resolver:

```ts
// After: an incomplete form declines Submitted, so `can` is false.
Submitted: { target: "Reviewing", guard: ({ state }) => state.email.length > 0 }

// A resolver that needs commands or construction declines explicitly.
// In make: branches: { submit: { review: { target: "Reviewing" } } }
Submitted: {
  branches: "submit",
  declinable: true,
  resolve: ({ state, select, decline }) =>
    state.email.length > 0 ? select.review() : decline()
}
```

Keep `none` for events that are deliberately accepted and ignored. The
`effect-machine/no-conditional-none-branch` lint rule reports the conditional
fallback.

Query acceptance during render through `AtomMachine.can(event)(machine)`. Do
not call `Effect.runSync(Machine.can(...))` in a component: the atom shares the
running machine's snapshot, suspends during startup, and recomputes when the
snapshot changes.

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

That component rerenders for every result change. Prefer typed path selectors
for state-owned UI.

Selection and equality belong to atoms, not to React hooks. To subscribe to
part of a selected value, derive an atom from the path selector and give it the
equality that defines a meaningful change. Declare the derivation once with
`Atom.family`, keyed by the machine atom, so every render reuses the same atom:

```tsx
import { useAtomSuspense } from "@effect/atom-react"
import { Equal, Option } from "effect"
import { Atom } from "effect/reactivity"

type AuthMachineAtom = ReturnType<typeof useAuthMachine>

const editingEmail = Atom.family((machine: AuthMachineAtom) =>
  Atom.mapResult(
    AtomMachine.select(machine, "Editing"),
    Option.map(({ email }) => email)
  ).pipe(Atom.withEquality(Equal.equals))
)

function EmailField() {
  const machine = useAuthMachine()
  const email = useAtomSuspense(editingEmail(machine)).value

  return Option.match(email, {
    onNone: () => null,
    onSome: (email) => <input value={email} />
  })
}
```

The component rerenders only when the projected email changes, not when other
`Editing` fields change. Do not create a fresh derived atom on every render.

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
replacement child instance. `MachineState` accepts the child bridge directly
and renders `inactive` in both cases.

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

## Generic helpers

Use `AtomMachine.MachineAtom.Any` and `AtomMachine.ChildMachineAtom.Any` to
accept any bridge, including bridges for machines without events. Recover the
exact types with the namespace extractors:

```ts
function StateView<A extends AtomMachine.MachineAtom.Any>(props: {
  readonly machine: A
  readonly render: (state: AtomMachine.MachineAtom.State<A>) => React.ReactNode
}) {
  const state = useAtomSuspense(props.machine.result).value
  return props.render(state)
}

type AuthEvent = AtomMachine.MachineAtom.Event<typeof AuthMachineAtom>
type EditorState = AtomMachine.ChildMachineAtom.State<
  AtomMachine.ChildOf<typeof AuthMachineAtom, typeof Editor>
>
```

## Keep workflow effects out of emissions

Emissions are ephemeral notifications for observers. They are not replayed, so
a subscriber that mounts late never sees an earlier emission. Do not drive work
the workflow depends on, such as navigation, from emissions. Invoke that work
from the state that requires it through a capability service, as in
[Per-owner capabilities](#per-owner-capabilities); the machine then decides when
it runs, what cancels it, and how failure changes the workflow.

An emission that only feeds UI feedback has two stream-atom details:

- `Atom.make(AtomMachine.emissions(machine))` publishes each emission as a
  waiting `Success`, then publishes the last emission again, no longer waiting,
  when the machine completes. Handlers must tolerate that repeated value.
- `useAtomSubscribe(atom, f)` subscribes after commit without reading the atom.
  Pass `{ immediate: true }` so a lazy emissions atom starts; without it the
  callback never runs. The callback then also receives the initial result.

## Registry and rendering semantics

A `MachineAtom` identifies one machine per `AtomRegistry`. Passing the same
machine atom through two registry providers creates two independent runtimes.
Unmounting a React owner releases its mount. The registry stops the machine
after its final subscription and configured idle retention expire.
`registry.dispose()` stops it immediately.

`useMachineAtom` does not start a machine during server rendering because
React effects do not run on the server. Server reads never start a machine
either. Every bridge atom carries an Effect Atom server value, which
`@effect/atom-react` hooks read during server rendering and hydration, and
`Atom.getServerValue` reads directly:

| Atom                                                  | Server value                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `ref`, `send`, `stop`                                 | `Initial`                                                                                                     |
| `snapshot`                                            | `Success({ status: "active", state })`, waiting                                                               |
| `result`                                              | `Success(state)`, waiting                                                                                     |
| `select`, `selectSnapshot`, `matches`, `can`          | the projection of `state`, waiting                                                                            |
| `child(Child).result` and child projections           | `Success(Option.some(childState))` when the planned state invokes `Child`, otherwise `Success(Option.none())` |
| `family` and `familyChild` projections                | the server value of the projected bridge atom                                                                 |

`state` is the machine's planned startup state: the state `Machine.planInitial`
settles into with the bridge's input, without running startup commands,
invocations, or services. A resumed bridge uses its resumed snapshot. Children
spawned at runtime or through child families are `Option.none()`. When the
startup state cannot be planned synchronously, for example because the input
is invalid, every server value is `Initial`. Each bridge plans at most once,
on its first server read.

## Server rendering and hydration

Render state slots with `MachineState` and no Suspense boundary:

```tsx
<Onboarding.Provider input={input}>
  <MachineState machine={Onboarding.useMachine()} path="Editing">
    {(editing) => <input value={editing.value.email} onChange={onChange} />}
  </MachineState>
</Onboarding.Provider>
```

The server renders the planned `Editing` snapshot. Hydration renders the same
markup, then the Provider mounts the machine and the same component tree
receives live snapshots. The input keeps its DOM node, typed text, and focus.

Do not wrap hydrated forms in a Suspense boundary that a startup read can
trigger. A suspended boundary replaces its server-rendered content with the
fallback and later mounts new DOM nodes, discarding typed text and focus.
