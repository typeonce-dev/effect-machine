import { Machine } from "@typeonce/effect-machine"
import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { Effect, Schema } from "effect"
import { Atom } from "effect/unstable/reactivity"
import { ReplaceMachine } from "./machines/replace.ts"
import { SelectionMachine } from "./machines/selection.ts"
import { Pokemon, PokemonService, TeamEvents } from "./pokemon.ts"

class ActiveTeam extends Schema.TaggedClass<ActiveTeam>("ActiveTeam")("ActiveTeam", {
  team: Schema.Array(Pokemon)
}) {}

export const States = Machine.states({ Loading: {}, ActiveTeam, Failed: {} })

export const SelectionChild = Machine.child("selection", SelectionMachine)
export const ReplaceChild = Machine.child("replace", ReplaceMachine)

const machine = Machine.make({
  states: States.states,
  events: TeamEvents,
  initial: {
    target: (to) => to.Loading(),
    resolve: ({ target }) => target.from()
  }
}).handle({
  Loading: {
    invoke: Machine.invoke({
      id: "load-team",
      effect: () =>
        Effect.gen(function*() {
          const service = yield* PokemonService
          return yield* service.getRandomTeam()
        }),
      onDone: Machine.transition({
        target: (to) => to.full.ActiveTeam(),
        resolve: ({ output, target }) => target.from({ team: output })
      }),
      onFailure: Machine.transition({
        target: (to) => to.full.Failed(),
        resolve: ({ target }) => target.from()
      })
    })
  },
  ActiveTeam: {
    invoke: [
      Machine.invoke({
        child: SelectionChild,
        onDone: Machine.transition({
          target: (to) => to.none(),
          resolve: () => undefined
        }),
        onFailure: Machine.transition({
          target: (to) => to.full.Failed(),
          resolve: ({ target }) => target.from()
        })
      }),
      Machine.invoke({
        child: ReplaceChild,
        onFailure: Machine.transition({
          target: (to) => to.full.Failed(),
          resolve: ({ target }) => target.from()
        })
      })
    ],
    on: {
      ReplaceInTeam: Machine.transition({
        target: (to) => to.full.ActiveTeam(),
        resolve: ({ event, target, state }) =>
          target.from({
            team: state.team.map((pokemon) => (pokemon.id === event.id ? event.pokemon : pokemon))
          })
      })
    }
  },
  Failed: {}
})

const atomRuntime = Atom.runtime(PokemonService.layer)
export const machineAtom = AtomMachine.bind(atomRuntime).make(machine)

export const selectionMachineAtom = machineAtom.child(SelectionChild)
export const replaceMachineAtom = machineAtom.child(ReplaceChild)
