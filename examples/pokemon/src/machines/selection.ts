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

export const SelectionStates = Machine.states({
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
  parent: Machine.parent(TeamEvents),
  initial: (to) =>
    to.form.initial.resolve(({ target }) =>
      target.from((form) =>
        form
          .search.from({ searchText: "" }, (search) => search.NoPokemon.from())
          .selection.from((selection) => selection.Unselected.from())
      )
    )
}).handle({
  form: {
    states: {
      search: {
        on: {
          UpdateSearchText: (to) =>
            to.local.with.resolve(
              ({ event, target }) => target.from({ searchText: event.value }, (search) => search.Searching.from()),
              { reenter: true }
            )
        },
        states: {
          WithPokemon: {
            on: {
              ReplacePokemon: (to) =>
                to.full.form().resolve(({ event, parent, state, target }, enqueue) => {
                  enqueue.sendTo(parent, TeamEvents.ReplaceInTeam({ id: event.id, pokemon: state.pokemon }))
                  return target.from((form) =>
                    form
                      .search.from({ searchText: "" }, (search) => search.NoPokemon.from())
                      .selection.from((selection) => selection.Unselected.from())
                  )
                })
            }
          },
          Searching: {
            invoke: Machine.invoke({
              id: "search",
              effect: ({ ancestors }) => searchPokemon(ancestors["form.search"].searchText),
              onDone: (to) =>
                to.none.resolve(({ output }, enqueue) => {
                  enqueue.raise(output)
                }),
              onFailure: (to) => to.local.NoPokemon().resolve(({ target }) => target.from())
            }),
            on: {
              SearchResult: (to) =>
                to.branches({
                  found: { target: to.local.WithPokemon() },
                  notFound: { title: "Not found", target: to.local.NoPokemon() }
                }).resolve(({ event, select }) =>
                  Option.match(event.result, {
                    onNone: () => select.notFound.from(),
                    onSome: (pokemon) => select.found.from({ pokemon })
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
              SelectPokemon: (to) => to.local.Selected().resolve(({ event, target }) => target.from({ id: event.id }))
            }
          },
          Selected: {
            on: {
              SelectPokemon: (to) =>
                to.branches({
                  alreadySelected: { title: "Already selected", target: to.local.Unselected() },
                  selected: { target: to.local.Selected() }
                }).resolve(({ event, select, state }) =>
                  state.id === event.id
                    ? select.alreadySelected.from()
                    : select.selected.from({ id: event.id })
                )
            }
          }
        }
      }
    }
  }
})
