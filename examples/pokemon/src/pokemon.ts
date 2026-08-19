import { Machine } from "@typeonce/effect-machine"
import { Array, Context, Effect, flow, Layer, Option, Random, Schema } from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse
} from "effect/unstable/http"

export const Pokemon = Schema.Struct({
  id: Schema.Number,
  name: Schema.NonEmptyString,
  order: Schema.Number,
  sprites: Schema.Struct({
    front_default: Schema.NonEmptyString,
    back_default: Schema.NonEmptyString
  })
})

export const TeamEvents = Machine.events(
  Schema.TaggedUnion({
    ReplaceInTeam: {
      id: Pokemon.fields.id,
      pokemon: Pokemon
    }
  })
)

export class PokemonService extends Context.Service<PokemonService>()("app/PokemonService", {
  make: Effect.gen(function*() {
    const baseClient = yield* HttpClient.HttpClient
    const client = baseClient.pipe(
      HttpClient.mapRequest(
        flow(HttpClientRequest.prependUrl("https://pokeapi.co/api/v2"), HttpClientRequest.acceptJson)
      )
    )

    return {
      getRandomTeam: Effect.fn("PokemonService.getTeam")(function*() {
        const teamIndexes = yield* Random.shuffle(Array.range(1, 1025)).pipe(Effect.map(Array.take(6)))

        return yield* Effect.all(
          teamIndexes.map((index) =>
            client.get(`/pokemon/${index}`).pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Pokemon)))
          ),
          { concurrency: 3 }
        )
      }),

      getRandomPokemon: Effect.fn("PokemonService.getRandomPokemon")(function*() {
        const index = yield* Random.nextIntBetween(1, 1025)
        const response = yield* client.get(`/pokemon/${index}`)
        return yield* HttpClientResponse.schemaBodyJson(Pokemon)(response)
      }),

      getByName: Effect.fn("PokemonService.getByName")(function*(name: string) {
        const response = yield* client.get(`/pokemon/${encodeURIComponent(name.trim().toLowerCase())}`)
        return yield* HttpClientResponse.matchStatus(response, {
          404: () => Effect.succeed(Option.none()),
          "2xx": (response) => HttpClientResponse.schemaBodyJson(Pokemon)(response).pipe(Effect.map(Option.some)),
          orElse: (response) =>
            Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.StatusCodeError({
                  response,
                  request: response.request,
                  description: "non 2xx status code"
                })
              })
            )
        })
      })
    }
  })
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
