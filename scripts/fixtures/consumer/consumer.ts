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
const PublicEvents = Machine.events(PublicEvent)
const InternalEvents = Machine.internalEvents(InternalEvent)

const machine = Machine.make({
  id: "Consumer",
  states: States.states,
  events: PublicEvents,
  internalEvents: InternalEvents,
  initial: {
    target: (to) => to.Idle(),
    resolve: ({ target }) => target(State.cases.Idle.make({}))
  }
}).handle({
  Idle: {
    on: {
      Start: Machine.transition({
        target: (to) => to.full.Loading(),
        resolve: ({ target }) => target(State.cases.Loading.make({}))
      })
    }
  },
  Loading: {
    on: {
      Loaded: Machine.transition({
        target: (to) => to.full.Done(),
        resolve: ({ event, target }) => target(State.cases.Done.make({ value: event.value }))
      })
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
  effect: () => Effect.succeed("ready"),
  onDone: Machine.transition({ target: (to) => to.none(), resolve: () => undefined })
})
const delayed = Machine.invoke({
  id: "fixture-delay",
  after: "1 second",
  onDone: Machine.transition({ target: (to) => to.none(), resolve: () => undefined })
})
const generated = MachineTest.scenarios(machine, { minEvents: 1, maxEvents: 2 })

type InputEvent = Machine.Machine.InputEvent<typeof machine>
type HandledEvent = Machine.Machine.Event<typeof machine>

const constructedStart = PublicEvents.Start()
const constructedLoaded = InternalEvents.Loaded({ value: "ready" })
const start: InputEvent = { _tag: "Start" }
const loaded: HandledEvent = { _tag: "Loaded", value: "ready" }

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
  constructedStart,
  constructedLoaded,
  start,
  loaded,
  invalidInput
]
