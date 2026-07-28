import { Effect, Option, Schema } from "effect"
import { Machine } from "@typeonce/effect-machine"
import { Pokemon, PokemonService } from "../pokemon.ts"

class Form extends Schema.TaggedClass<Form>("Form")("Form", {}) {}

class Search extends Schema.TaggedClass<Search>("Search")("Search", {
  searchText: Schema.String
}) {}

class Selection extends Schema.TaggedClass<Selection>("Selection")("Selection", {}) {}

class Unselected extends Schema.TaggedClass<Unselected>("Unselected")("Unselected", {}) {}

class Selected extends Schema.TaggedClass<Selected>("Selected")("Selected", {
  id: Pokemon.fields.id
}) {}

class NoPokemon extends Schema.TaggedClass<NoPokemon>("NoPokemon")("NoPokemon", {}) {}

class WithPokemon extends Schema.TaggedClass<WithPokemon>("WithPokemon")("WithPokemon", {
  pokemon: Pokemon
}) {}

class Searching extends Schema.TaggedClass<Searching>("Searching")("Searching", {}) {}

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

/** Emits */

class ReplaceInTeam extends Schema.TaggedClass<ReplaceInTeam>("ReplaceInTeam")("ReplaceInTeam", {
  id: Pokemon.fields.id,
  pokemon: Pokemon
}) {}

const SearchMachine = ({ searchText }: { searchText: string }) =>
  Machine.invoke({
    id: "search",
    src: () =>
      Machine.effect(
        Effect.sleep("500 millis").pipe(
          Effect.andThen(
            Effect.gen(function* () {
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
    schema: Form,
    type: "parallel",
    states: {
      search: {
        schema: Search,
        initial: "NoPokemon",
        states: {
          NoPokemon,
          WithPokemon,
          Searching
        }
      },
      selection: {
        schema: Selection,
        initial: "Unselected",
        states: {
          Unselected,
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
    SelectionStates.initial.form(new Form(), (form) =>
      form
        .search(new Search({ searchText: "" }), (search) => search.NoPokemon(new NoPokemon()))
        .selection(new Selection(), (selection) => selection.Unselected(new Unselected()))
    )
}).handle({
  form: {
    states: {
      search: {
        on: {
          UpdateSearchText: {
            reenter: true,
            transition: ({ event, target }) =>
              target.local.with(new Search({ searchText: event.value }), (search) => search.Searching(new Searching()))
          }
        },
        states: {
          WithPokemon: {
            on: {
              ReplacePokemon: ({ event, emit, state, target }) =>
                emit(new ReplaceInTeam({ id: event.id, pokemon: state.pokemon })).pipe(
                  Effect.as(
                    target.full.form(new Form(), (form) =>
                      form
                        .search(new Search({ searchText: "" }), (search) => search.NoPokemon(new NoPokemon()))
                        .selection(new Selection(), (selection) => selection.Unselected(new Unselected()))
                    )
                  )
                )
            }
          },
          Searching: {
            invoke: ({ parents }) => SearchMachine({ searchText: parents["form.search"].searchText }),
            on: {
              SearchResult: ({ event, target }) =>
                event.result.pipe(
                  Option.match({
                    onNone: () => target.local.NoPokemon(new NoPokemon()),
                    onSome: (pokemon) => target.local.WithPokemon(new WithPokemon({ pokemon }))
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
              SelectPokemon: ({ event, target }) => target.local.Selected(new Selected({ id: event.id }))
            }
          },
          Selected: {
            on: {
              SelectPokemon: ({ event, target, state }) =>
                state.id === event.id
                  ? target.local.Unselected(new Unselected())
                  : target.local.Selected(new Selected({ id: event.id }))
            }
          }
        }
      }
    }
  }
})
