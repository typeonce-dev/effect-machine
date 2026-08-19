import { Machine } from "@typeonce/effect-machine"
import { Effect, Schema } from "effect"
import { Pokemon, PokemonService, TeamEvents } from "../pokemon.ts"

class Replacing extends Schema.TaggedClass<Replacing>("Replacing")("Replacing", {
  id: Pokemon.fields.id
}) {}

export const ReplaceStates = Machine.states({
  Idle: {},
  Replacing
})

export const ReplaceEvents = Machine.events(
  Schema.TaggedUnion({ ReplacePokemon: { id: Pokemon.fields.id } })
)
const ReplaceInternalEvents = Machine.internalEvents(
  Schema.TaggedUnion({ Replaced: { pokemon: Pokemon } })
)
export const ReplaceMachine = Machine.make({
  states: ReplaceStates.states,
  events: ReplaceEvents,
  internalEvents: ReplaceInternalEvents,
  parent: Machine.parent(TeamEvents),
  initial: (to) => to.Idle().resolve(({ target }) => target.from())
}).handle({
  Idle: {
    on: {
      ReplacePokemon: (to) => to.full.Replacing().resolve(({ event, target }) => target.from({ id: event.id }))
    }
  },
  Replacing: {
    invoke: (from) =>
      from.effect("replaceWithRandom", () =>
        Effect.sleep("500 millis").pipe(
          Effect.andThen(
            Effect.gen(function*() {
              const service = yield* PokemonService
              const pokemon = yield* service.getRandomPokemon()
              return ReplaceInternalEvents.Replaced({ pokemon })
            })
          ),
          Effect.onInterrupt(() => Effect.log("Replace with random interrupted"))
        )).onDone((to) =>
          to.none.resolve(({ output }, enqueue) => {
            enqueue.raise(output)
          })
        ).onFailure((to) => to.full.Idle().resolve(({ target }) => target.from())),
    on: {
      Replaced: (to) =>
        to.full.Idle().resolve(({ event, parent, state, target }, enqueue) => {
          enqueue.sendTo(parent, TeamEvents.ReplaceInTeam({ id: state.id, pokemon: event.pokemon }))
          return target.from()
        })
    }
  }
})
