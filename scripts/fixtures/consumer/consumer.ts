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

const States = Machine.state({ initial: "Idle", states: State.cases })
const PublicEvents = Machine.eventsFromSchemas(PublicEvent)
const InternalEvents = Machine.internalEventsFromSchemas(InternalEvent)

const targets = Machine.targets(States)
const machine = Machine.make({
  effects: { load: Effect.succeed("ready") },
  timers: { delay: "1 second" },
  branches: {
    start: {
      cached: { target: targets.root.Loading },
      measured: { none: true },
      named: { target: targets.root.Done },
      confirmed: { target: targets.root.Idle }
    }
  },
  id: "Consumer",
  root: States,
  events: PublicEvents,
  internalEvents: InternalEvents,
  initialConfiguration: (root) =>
    root.resolve(({ target }) => target.from((to) => to.Idle.decoded(State.cases.Idle.make({}))))
}).handle({
  states: {
    Idle: {
      on: {
        Start: { branches: "start", resolve: ({ select }) => select.cached.decoded(State.cases.Loading.make({})) }
      }
    },
    Loading: {
      invoke: [{ src: "load", id: "fixture-load", onDone: { none: true } }, {
        src: "delay",
        id: "fixture-delay",
        onDone: { none: true }
      }],
      on: {
        Loaded: { target: targets.root.Done, decoded: ({ event }) => State.cases.Done.make({ value: event.value }) }
      }
    },
    Done: {}
  }
})

const atoms = AtomMachine.make(machine)
const idleAtom = AtomMachine.select(atoms, "Idle")
const loadingAtom = AtomMachine.matches(atoms, "Loading")
// @ts-expect-error Atom selectors infer valid paths from the bridge snapshot.
const invalidSelector = AtomMachine.select(atoms, "Missing")
const cluster = ClusterMachine.make("ConsumerEntity", machine, {
  version: "1"
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
  generated,
  constructedStart,
  constructedLoaded,
  start,
  loaded,
  invalidInput
]
