import { Machine } from "@typeonce/effect-machine"
import { Effect, Option, Schema } from "effect"
import { Pokemon, PokemonService, ReplaceInTeam } from "../pokemon.ts"

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

const SearchMachine = ({ searchText }: { searchText: string }) =>
  Machine.invoke({
    id: "search",
    src: () =>
      Machine.effect(
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
      )
  })

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

export { SelectPokemon, UpdateSearchText }
export const SelectionMachine = Machine.make({
  states: SelectionStates.states,
  events: [SelectPokemon, UpdateSearchText, SearchResult, ReplacePokemon],
  emits: [ReplaceInTeam],
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
              ReplacePokemon: ({ event, state, target }, enqueue) => {
                enqueue.emit(new ReplaceInTeam({ id: event.id, pokemon: state.pokemon }))
                return target.full.form.from((form) =>
                  form
                    .search.from({ searchText: "" }, (search) => search.NoPokemon.from())
                    .selection.from((selection) => selection.Unselected.from())
                )
              }
            }
          },
          Searching: {
            invoke: ({ parents }) => SearchMachine({ searchText: parents["form.search"].searchText }),
            on: {
              SearchResult: ({ event, target }) =>
                event.result.pipe(
                  Option.match({
                    onNone: () => target.local.NoPokemon.from(),
                    onSome: (pokemon) => target.local.WithPokemon.from({ pokemon })
                  })
                )
            }
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
