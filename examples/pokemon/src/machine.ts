import { Machine } from "@typeonce/effect-machine"
import { Effect, Schema } from "effect"
import { ReplaceMachine } from "./machines/replace.ts"
import { SelectionMachine } from "./machines/selection.ts"
import { Pokemon, PokemonService, TeamEvents } from "./pokemon.ts"

class ActiveTeam extends Schema.TaggedClass<ActiveTeam>("ActiveTeam")("ActiveTeam", {
  team: Schema.Array(Pokemon)
}) {}

export const States = Machine.states({
  Loading: {},
  ActiveTeam,
  Failed: {}
})

export const SelectionChild = Machine.child("selection", SelectionMachine)
export const ReplaceChild = Machine.child("replace", ReplaceMachine)

export const machine = Machine.make({
  states: States.states,
  events: TeamEvents,
  initial: (to) => to.Loading().resolve(({ target }) => target.from())
}).handle({
  Loading: {
    invoke: (from) =>
      from.effect("load-team", () =>
        Effect.gen(function*() {
          const service = yield* PokemonService
          return yield* service.getRandomTeam()
        })).onDone((to) => to.full.ActiveTeam().resolve(({ output, target }) => target.from({ team: output })))
        .onFailure((to) => to.full.Failed().resolve(({ target }) => target.from()))
  },
  ActiveTeam: {
    invoke: (
      from
    ) => [
      from.child(SelectionChild).onFailure((to) => to.full.Failed().resolve(({ target }) => target.from())),
      from.child(ReplaceChild).onFailure((to) => to.full.Failed().resolve(({ target }) => target.from()))
    ],
    on: {
      ReplaceInTeam: (to) =>
        to.full.ActiveTeam().resolve(({ event, target, state }) =>
          target.from({
            team: state.team.map((pokemon) => (pokemon.id === event.id ? event.pokemon : pokemon))
          })
        )
    }
  },
  Failed: {}
})
