import { Machine } from "@typeonce/effect-machine"
import { Effect, Option, Schema } from "effect"
import { Pokemon, PokemonService, TeamEvents } from "../pokemon.ts"

class Search extends Schema.TaggedClass<Search>("Search")("Search", {
  searchText: Schema.String
}) {}

class Selected extends Schema.TaggedClass<Selected>("Selected")("Selected", {
  id: Pokemon.fields.id
}) {}

class WithPokemon extends Schema.TaggedClass<WithPokemon>("WithPokemon")("WithPokemon", {
  pokemon: Pokemon
}) {}

/** Events */

class SelectPokemon extends Schema.TaggedClass<SelectPokemon>("SelectPokemon")("SelectPokemon", {
  id: Pokemon.fields.id
}) {}

class UpdateSearchText extends Schema.TaggedClass<UpdateSearchText>("UpdateSearchText")("UpdateSearchText", {
  value: Schema.String
}) {}

class SearchResult extends Schema.TaggedClass<SearchResult>("SearchResult")("SearchResult", {
  result: Schema.Option(Pokemon)
}) {}

class ReplacePokemon extends Schema.TaggedClass<ReplacePokemon>("ReplacePokemon")("ReplacePokemon", {
  id: Pokemon.fields.id
}) {}

const searchPokemon = (searchText: string) =>
  Effect.sleep("500 millis").pipe(
    Effect.andThen(
      Effect.gen(function*() {
        const pk = yield* PokemonService
        const pokemon = yield* pk.getByName(searchText)
        return new SearchResult({ result: pokemon })
      })
    ),
    Effect.onInterrupt(() => Effect.log("Search interrupted"))
  )

export const SelectionStates = Machine.defineStates({
  form: {
    type: "parallel",
    states: {
      search: {
        schema: Search,
        initial: "NoPokemon",
        states: {
          NoPokemon: {},
          WithPokemon,
          Searching: {}
        }
      },
      selection: {
        initial: "Unselected",
        states: {
          Unselected: {},
          Selected
        }
      }
    }
  }
})

export const SelectionEvents = Machine.events(SelectPokemon, UpdateSearchText, SearchResult, ReplacePokemon)
export const SelectionMachine = Machine.make({
  states: SelectionStates.states,
  events: SelectionEvents,
  parentEvents: TeamEvents,
  initial: () =>
    SelectionStates.initial.form.from((form) =>
      form
        .search.from({ searchText: "" }, (search) => search.NoPokemon.from())
        .selection.from((selection) => selection.Unselected.from())
    )
}).handle({
  form: {
    states: {
      search: {
        on: {
          UpdateSearchText: {
            reenter: true,
            transition: ({ event, target }) =>
              target.local.with.from({ searchText: event.value }, (search) => search.Searching.from())
          }
        },
        states: {
          WithPokemon: {
            on: {
              ReplacePokemon: ({ event, parent, state, target }, enqueue) => {
                if (parent !== undefined) {
                  enqueue.sendTo(parent, TeamEvents.ReplaceInTeam({ id: event.id, pokemon: state.pokemon }))
                }
                return target.full.form.from((form) =>
                  form
                    .search.from({ searchText: "" }, (search) => search.NoPokemon.from())
                    .selection.from((selection) => selection.Unselected.from())
                )
              }
            }
          },
          Searching: {
            invoke: Machine.invoke({
              id: "search",
              effect: ({ ancestors }) => searchPokemon(ancestors["form.search"].searchText),
              onDone: ({ output, target }) =>
                output.result.pipe(
                  Option.match({
                    onNone: () => target.local.NoPokemon.from(),
                    onSome: (pokemon) => target.local.WithPokemon.from({ pokemon })
                  })
                ),
              onFailure: ({ target }) => target.local.NoPokemon.from()
            })
          }
        }
      },
      selection: {
        states: {
          Unselected: {
            on: {
              SelectPokemon: ({ event, target }) => target.local.Selected.from({ id: event.id })
            }
          },
          Selected: {
            on: {
              SelectPokemon: ({ event, target, state }) =>
                state.id === event.id
                  ? target.local.Unselected.from()
                  : target.local.Selected.from({ id: event.id })
            }
          }
        }
      }
    }
  }
})
