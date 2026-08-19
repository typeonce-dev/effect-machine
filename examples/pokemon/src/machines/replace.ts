import { Machine } from "@typeonce/effect-machine"
import { Effect, Schema } from "effect"
import { Pokemon, PokemonService, TeamEvents } from "../pokemon.ts"

class Replacing extends Schema.TaggedClass<Replacing>("Replacing")("Replacing", {
  id: Pokemon.fields.id
}) {}

/** Events */

class ReplacePokemon extends Schema.TaggedClass<ReplacePokemon>("ReplacePokemon")("ReplacePokemon", {
  id: Pokemon.fields.id
}) {}

class Replaced extends Schema.TaggedClass<Replaced>("Replaced")("Replaced", {
  pokemon: Pokemon
}) {}

const replaceWithRandom = Effect.sleep("500 millis").pipe(
  Effect.andThen(
    Effect.gen(function*() {
      const pk = yield* PokemonService
      const pokemon = yield* pk.getRandomPokemon()
      return new Replaced({ pokemon })
    })
  ),
  Effect.onInterrupt(() => Effect.log("Replace with random interrupted"))
)

export const ReplaceStates = Machine.states({ Idle: {}, Replacing })

export const ReplaceEvents = Machine.events(ReplacePokemon)
const ReplaceInternalEvents = Machine.internalEvents(Replaced)
export const ReplaceMachine = Machine.make({
  states: ReplaceStates.states,
  events: ReplaceEvents,
  internalEvents: ReplaceInternalEvents,
  parentEvents: TeamEvents,
  initial: (to) => to.Idle().resolve(({ target }) => target.from())
}).handle({
  Idle: {
    on: {
      ReplacePokemon: (to) => to.full.Replacing().resolve(({ event, target }) => target.from({ id: event.id }))
    }
  },
  Replacing: {
    invoke: Machine.invoke({
      id: "replaceWithRandom",
      effect: () => replaceWithRandom,
      onDone: (to) =>
        to.none.resolve(({ output }, enqueue) => {
          enqueue.raise(ReplaceInternalEvents.Replaced({ pokemon: output.pokemon }))
        }),
      onFailure: (to) => to.full.Idle().resolve(({ target }) => target.from())
    }),
    on: {
      Replaced: (to) =>
        to.full.Idle().resolve(({ event, parent, state, target }, enqueue) => {
          if (parent !== undefined) {
            enqueue.sendTo(parent, TeamEvents.ReplaceInTeam({ id: state.id, pokemon: event.pokemon }))
          }
          return target.from()
        })
    }
  }
})
