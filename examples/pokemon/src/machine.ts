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

export const States = Machine.defineStates({ Loading: {}, ActiveTeam, Failed: {} })

export const SelectionChild = Machine.child("selection", SelectionMachine)
export const ReplaceChild = Machine.child("replace", ReplaceMachine)

const machine = Machine.make({
  states: States.states,
  events: [ReplaceInTeam],
  initial: () => States.initial.Loading.from()
}).handle({
  Loading: {
    invoke: Machine.invoke({
      id: "load-team",
      effect: Effect.gen(function*() {
        const service = yield* PokemonService
        return yield* service.getRandomTeam()
      }),
      onDone: ({ output, target }) => target.full.ActiveTeam.from({ team: output }),
      onFailure: ({ target }) => target.full.Failed.from()
    })
  },
  ActiveTeam: {
    invoke: [
      Machine.invoke({
        child: SelectionChild,
        onDone: () => undefined,
        onFailure: ({ target }) => target.full.Failed.from()
      }),
      Machine.invoke({ child: ReplaceChild, onFailure: ({ target }) => target.full.Failed.from() })
    ],
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
