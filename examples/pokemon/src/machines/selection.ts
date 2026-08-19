import { Machine } from "@typeonce/effect-machine"
import { Effect, Option, Schema } from "effect"
import { Pokemon, PokemonService, TeamEvents } from "../pokemon.ts"

const State = Schema.TaggedUnion({
  Selected: {
    id: Pokemon.fields.id,
    searchText: Schema.String
  },
  WithPokemon: { pokemon: Pokemon }
})

export const SelectionStates = Machine.states({
  form: {
    initial: "Unselected",
    states: {
      Unselected: {},
      Selected: {
        schema: State.cases.Selected,
        initial: "NoPokemon",
        states: {
          NoPokemon: {},
          WithPokemon: State.cases.WithPokemon,
          Searching: {}
        }
      }
    }
  }
})

export const SelectionEvents = Machine.events(
  Schema.TaggedUnion({
    SelectPokemon: { id: Pokemon.fields.id },
    UpdateSearchText: { value: Schema.String },
    ReplacePokemon: {}
  })
)

const SelectionInternalEvents = Machine.internalEvents(
  Schema.TaggedUnion({ SearchResult: { result: Schema.Option(Pokemon) } })
)

export const SelectionMachine = Machine.make({
  states: SelectionStates.states,
  events: SelectionEvents,
  internalEvents: SelectionInternalEvents,
  parent: Machine.parent(TeamEvents),
  initial: (to) => to.form.initial.resolve(({ target }) => target.from((form) => form.Unselected.from()))
}).handle({
  form: {
    states: {
      Unselected: {
        on: {
          SelectPokemon: (to) =>
            to.local.Selected.initial.resolve(({ event, target }) => target.from({ id: event.id, searchText: "" }))
        }
      },
      Selected: {
        on: {
          SelectPokemon: (to) =>
            to.branches({
              unselected: { title: "Unselect", target: to.branch.form.Unselected() },
              selected: { title: "Select another Pokémon", target: to.branch.form.Selected.initial }
            }).resolve(({ event, select, state }) =>
              state.id === event.id
                ? select.unselected.from()
                : select.selected.from({ id: event.id, searchText: "" })
            ),
          UpdateSearchText: (to) =>
            to.local.with.resolve(
              ({ event, state, target }) =>
                target.from(
                  { id: state.id, searchText: event.value },
                  (selected) => selected.Searching.from()
                ),
              { reenter: true }
            )
        },
        states: {
          WithPokemon: {
            on: {
              ReplacePokemon: (to) =>
                to.branch.form.Unselected().resolve(({ ancestors, parent, state, target }, enqueue) => {
                  enqueue.sendTo(
                    parent,
                    TeamEvents.ReplaceInTeam({
                      id: ancestors["form.Selected"].id,
                      pokemon: state.pokemon
                    })
                  )
                  return target.from()
                })
            }
          },
          Searching: {
            invoke: (from) =>
              from.effect("search", ({ ancestors }) =>
                Effect.sleep("500 millis").pipe(
                  Effect.andThen(
                    Effect.gen(function*() {
                      const service = yield* PokemonService
                      const pokemon = yield* service.getByName(ancestors["form.Selected"].searchText)
                      return SelectionInternalEvents.SearchResult({ result: pokemon })
                    })
                  ),
                  Effect.onInterrupt(() => Effect.log("Search interrupted"))
                )).onDone((to) =>
                  to.none.resolve(({ output }, enqueue) => {
                    enqueue.raise(output)
                  })
                ).onFailure((to) => to.local.NoPokemon().resolve(({ target }) => target.from())),
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
      }
    }
  }
})
