import { Machine } from "@typeonce/effect-machine"
import { ClusterMachine } from "@typeonce/effect-machine/cluster"
import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { MachineTest } from "@typeonce/effect-machine/testing"
import { Effect, Schema } from "effect"

const State = Schema.TaggedUnion({
  Idle: {},
  Loading: {},
  Done: { value: Schema.String }
})

const PublicEvent = Schema.TaggedUnion({
  Start: {}
})

const InternalEvent = Schema.TaggedUnion({
  Loaded: { value: Schema.String }
})

const States = Machine.defineStates(State.cases)

const machine = Machine.make({
  id: "Consumer",
  states: States.states,
  events: [PublicEvent.cases.Start],
  internalEvents: [InternalEvent.cases.Loaded],
  initial: () => States.initial.Idle(State.cases.Idle.make({}))
}).handle({
  Idle: {
    on: {
      Start: ({ target }) => target.full.Loading(State.cases.Loading.make({}))
    }
  },
  Loading: {
    on: {
      Loaded: ({ event, target }) => target.full.Done(State.cases.Done.make({ value: event.value }))
    }
  },
  Done: {}
})

const atoms = AtomMachine.make(machine)
const idleAtom = AtomMachine.select(atoms, "Idle")
const loadingAtom = AtomMachine.matches(atoms, "Loading")
// @ts-expect-error Atom selectors infer valid paths from the bridge snapshot.
const invalidSelector = AtomMachine.select(atoms, "Missing")
const cluster = ClusterMachine.make("ConsumerEntity", machine, {
  version: "1"
})
const invoked = Machine.invoke({
  id: "fixture-load",
  effect: Effect.succeed("ready"),
  onDone: () => undefined
})
const delayed = Machine.invoke({
  id: "fixture-delay",
  after: "1 second",
  onDone: () => undefined
})
const generated = MachineTest.scenarios(machine, { minEvents: 1, maxEvents: 2 })

type InputEvent = Machine.Machine.InputEvent<typeof machine>
type HandledEvent = Machine.Machine.Event<typeof machine>

const start: InputEvent = PublicEvent.cases.Start.make({})
const loaded: HandledEvent = InternalEvent.cases.Loaded.make({ value: "ready" })

// @ts-expect-error Internal events cannot cross the public input boundary.
const invalidInput: InputEvent = loaded

void [
  atoms,
  idleAtom,
  loadingAtom,
  invalidSelector,
  cluster,
  invoked,
  delayed,
  generated,
  start,
  loaded,
  invalidInput
]
