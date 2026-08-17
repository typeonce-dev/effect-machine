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
const definition = Machine.make({
  states: SelectionStates.states,
  events: SelectionEvents,
  parentEvents: TeamEvents,
  initial: {
    target: (to) => to.form.initial(),
    resolve: ({ target }) =>
      target.from((form) =>
        form
          .search.from({ searchText: "" }, (search) => search.NoPokemon.from())
          .selection.from((selection) => selection.Unselected.from())
      )
  }
})

export const SelectionMachine = definition.handle({
  form: {
    states: {
      search: {
        on: {
          UpdateSearchText: Machine.transition({
            target: (to) => to.local.with(),
            resolve: ({ event, target }) =>
              target.from({ searchText: event.value }, (search) => search.Searching.from()),
            reenter: true
          })
        },
        states: {
          WithPokemon: {
            on: {
              ReplacePokemon: Machine.transition({
                target: (to) => to.full.form(),
                resolve: ({ event, parent, state, target }, enqueue) => {
                  if (parent !== undefined) {
                    enqueue.sendTo(parent, TeamEvents.ReplaceInTeam({ id: event.id, pokemon: state.pokemon }))
                  }
                  return target.from((form) =>
                    form
                      .search.from({ searchText: "" }, (search) => search.NoPokemon.from())
                      .selection.from((selection) => selection.Unselected.from())
                  )
                }
              })
            }
          },
          Searching: {
            invoke: definition.invoke({
              id: "search",
              effect: ({ ancestors }) => searchPokemon(ancestors["form.search"].searchText),
              onDone: Machine.transition({
                target: (to) => to.none(),
                resolve: ({ output }, enqueue) => {
                  enqueue.raise(output)
                  return undefined
                }
              }),
              onFailure: Machine.transition({
                target: (to) => to.local.NoPokemon(),
                resolve: ({ target }) => target.from()
              })
            }),
            on: {
              SearchResult: Machine.transition({
                cases: [{
                  title: "found",
                  when: ({ event }) => event.result,
                  target: (to) => to.local.WithPokemon(),
                  resolve: ({ match, target }) => target.from({ pokemon: match })
                }],
                otherwise: {
                  target: (to) => to.local.NoPokemon(),
                  resolve: ({ target }) => target.from()
                }
              })
            }
          }
        }
      },
      selection: {
        states: {
          Unselected: {
            on: {
              SelectPokemon: Machine.transition({
                target: (to) => to.local.Selected(),
                resolve: ({ event, target }) => target.from({ id: event.id })
              })
            }
          },
          Selected: {
            on: {
              SelectPokemon: Machine.transition({
                cases: [{
                  title: "already selected",
                  when: ({ event, state }) => state.id === event.id ? Option.some(undefined) : Option.none(),
                  target: (to) => to.local.Unselected(),
                  resolve: ({ target }) => target.from()
                }],
                otherwise: {
                  target: (to) => to.local.Selected(),
                  resolve: ({ event, target }) => target.from({ id: event.id })
                }
              })
            }
          }
        }
      }
    }
  }
})
