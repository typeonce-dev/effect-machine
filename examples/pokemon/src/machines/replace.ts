import { Machine } from "@typeonce/effect-machine"
import { Effect, Schema } from "effect"
import { Pokemon, PokemonService, ReplaceInTeam } from "../pokemon.ts"

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

export const ReplaceStates = Machine.defineStates({ Idle: {}, Replacing })

export const ReplaceEvents = Machine.events(ReplacePokemon, Replaced)
export const ReplaceMachine = Machine.make({
  states: ReplaceStates.states,
  events: ReplaceEvents,
  emits: [ReplaceInTeam],
  initial: () => ReplaceStates.initial.Idle.from()
}).handle({
  Idle: {
    on: {
      ReplacePokemon: ({ event, target }) => target.full.Replacing.from({ id: event.id })
    }
  },
  Replacing: {
    invoke: Machine.invoke({
      id: "replaceWithRandom",
      effect: replaceWithRandom,
      onDone: ({ output, target, state }, enqueue) => {
        enqueue.emit(new ReplaceInTeam({ id: state.id, pokemon: output.pokemon }))
        return target.full.Idle.from()
      },
      onFailure: ({ target }) => target.full.Idle.from()
    })
  }
})
