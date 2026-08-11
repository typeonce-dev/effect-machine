import { Machine } from "@typeonce/effect-machine"
import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { Effect, Schema } from "effect"
import { Atom } from "effect/unstable/reactivity"
import { ReplaceMachine } from "./machines/replace.ts"
import { SelectionMachine } from "./machines/selection.ts"
import { Pokemon, PokemonService, ReplaceInTeam } from "./pokemon.ts"

class ActiveTeam extends Schema.TaggedClass<ActiveTeam>("ActiveTeam")("ActiveTeam", {
  team: Schema.Array(Pokemon)
}) {}

class Loading extends Schema.TaggedClass<Loading>("Loading")("Loading", {}) {}

class TeamLoaded extends Schema.TaggedClass<TeamLoaded>("TeamLoaded")("TeamLoaded", {
  team: Schema.Array(Pokemon)
}) {}

class TeamLoadFailed extends Schema.TaggedClass<TeamLoadFailed>("TeamLoadFailed")("TeamLoadFailed", {}) {}

class Failed extends Schema.TaggedClass<Failed>("Failed")("Failed", {}) {}

export const States = Machine.defineStates({ Loading, ActiveTeam, Failed })

export const SelectionChild = Machine.child("selection", SelectionMachine)
export const ReplaceChild = Machine.child("replace", ReplaceMachine)

const LoadTeam = Machine.invokeEffect({
  id: "load-team",
  effect: Effect.gen(function*() {
    const service = yield* PokemonService
    return yield* service.getRandomTeam()
  }),
  onSuccess: (team) => new TeamLoaded({ team }),
  onFailure: () => new TeamLoadFailed({})
})

const machine = Machine.make({
  states: States.states,
  events: [ReplaceInTeam],
  internalEvents: [TeamLoaded, TeamLoadFailed],
  initial: () => States.initial.Loading.from()
}).handle({
  Loading: {
    invoke: LoadTeam,
    on: {
      TeamLoaded: ({ event, target }) => target.full.ActiveTeam.from({ team: event.team }),
      TeamLoadFailed: ({ target }) => target.full.Failed.from()
    }
  },
  ActiveTeam: {
    invoke: [Machine.invokeMachine({ child: SelectionChild }), Machine.invokeMachine({ child: ReplaceChild })],
    on: {
      ReplaceInTeam: ({ event, target, state }) =>
        target.full.ActiveTeam.from({
          team: state.team.map((pokemon) => (pokemon.id === event.id ? event.pokemon : pokemon))
        })
    }
  },
  Failed: {}
})

const atomRuntime = Atom.runtime(PokemonService.layer)
export const machineAtom = AtomMachine.bind(atomRuntime).make(machine)

export const selectionMachineAtom = machineAtom.child(SelectionChild)
export const replaceMachineAtom = machineAtom.child(ReplaceChild)
