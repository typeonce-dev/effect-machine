import { Effect, Schema } from "effect"
import { Machine } from "@typeonce/effect-machine"
import { Pokemon, PokemonService, ReplaceInTeam } from "../pokemon.ts"

class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}

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

const ReplaceWithRandomMachine = Machine.invoke({
  id: "replaceWithRandom",
  src: () =>
    Machine.effect(
      Effect.sleep("500 millis").pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const pk = yield* PokemonService
            const pokemon = yield* pk.getRandomPokemon()
            return new Replaced({ pokemon })
          })
        ),
        Effect.onInterrupt(() => Effect.log("Replace with random interrupted"))
      )
    )
})

export const ReplaceStates = Machine.defineStates({ Idle, Replacing })

export { ReplacePokemon }
export const ReplaceMachine = Machine.make({
  states: ReplaceStates.states,
  events: [ReplacePokemon, Replaced],
  emits: [ReplaceInTeam],
  initial: () => ReplaceStates.initial.Idle(new Idle())
}).handle({
  Idle: {
    on: {
      ReplacePokemon: ({ event, target }) => target.full.Replacing(new Replacing({ id: event.id }))
    }
  },
  Replacing: {
    invoke: () => ReplaceWithRandomMachine,
    on: {
      Replaced: ({ event, target, emit, state }) =>
        emit(new ReplaceInTeam({ id: state.id, pokemon: event.pokemon })).pipe(Effect.as(target.full.Idle(new Idle())))
    }
  }
})
