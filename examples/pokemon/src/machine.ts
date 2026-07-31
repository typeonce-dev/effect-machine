import { Effect, Schema } from "effect"
import { Machine } from "@typeonce/effect-machine"
import { Atom } from "effect/unstable/reactivity"
import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { ReplaceMachine } from "./machines/replace.ts"
import { SelectionMachine } from "./machines/selection.ts"
import { Pokemon, PokemonService, ReplaceInTeam } from "./pokemon.ts"

class ActiveTeam extends Schema.TaggedClass<ActiveTeam>("ActiveTeam")("ActiveTeam", {
  team: Schema.Array(Pokemon)
}) {}

export const States = Machine.defineStates({ ActiveTeam })

export const SelectionChild = Machine.child("selection", SelectionMachine)
export const ReplaceChild = Machine.child("replace", ReplaceMachine)

const machine = Machine.make({
  states: States.states,
  events: [ReplaceInTeam],
  initial: Effect.fn(function* () {
    const pk = yield* PokemonService
    const team = yield* pk.getRandomTeam()
    return States.initial.ActiveTeam(new ActiveTeam({ team }))
  })
}).handle({
  ActiveTeam: {
    invoke: [Machine.invokeMachine({ child: SelectionChild }), Machine.invokeMachine({ child: ReplaceChild })],
    on: {
      ReplaceInTeam: ({ event, target, state }) =>
        target.full.ActiveTeam(
          new ActiveTeam({ team: state.team.map((pokemon) => (pokemon.id === event.id ? event.pokemon : pokemon)) })
        )
    }
  }
})

const atomRuntime = Atom.runtime(PokemonService.layer)
export const machineAtom = AtomMachine.bind(atomRuntime).make(machine)

export const selectionMachineAtom = machineAtom.child(SelectionChild)
export const replaceMachineAtom = machineAtom.child(ReplaceChild)
