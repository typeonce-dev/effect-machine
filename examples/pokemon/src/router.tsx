import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { createRootRoute, createRoute, createRouter, Link, Outlet } from "@tanstack/react-router"
import { Match, Option } from "effect"
import { AsyncResult } from "effect/unstable/reactivity"
import { machineAtom, replaceMachineAtom, selectionMachineAtom } from "./atoms.js"
import { States } from "./machine.js"
import { ReplaceEvents, ReplaceStates } from "./machines/replace.ts"
import { SelectionEvents, SelectionStates } from "./machines/selection.ts"
import type { Pokemon } from "./pokemon.ts"

const rootRoute = createRootRoute({
  component: () => (
    <main>
      <nav>
        <Link to="/">Home</Link>
        <Link to="/machine">Machine</Link>
      </nav>
      <Outlet />
    </main>
  )
})

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => (
    <section>
      <h1>Effect Machine Playground</h1>
      <p>
        Edit <code>src/machine.ts</code> to build the machine.
      </p>
    </section>
  )
})

const machineRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/machine",
  component: MachinePage
})

function Selection() {
  const stateResult = useAtomValue(selectionMachineAtom.state)
  const send = useAtomSet(selectionMachineAtom.send)

  if (AsyncResult.isInitial(stateResult)) {
    return <p>Starting selection machine…</p>
  }

  if (AsyncResult.isFailure(stateResult)) {
    return <p>Selection machine failed.</p>
  }

  const state = stateResult.value

  if (Option.isNone(state)) {
    return null
  }

  return (
    <section className="machine-panel">
      <p>Selection state: {state.value.path}</p>

      {SelectionStates.get(state.value, "form.Selected").pipe(
        Option.match({
          onNone: () => <p>No Pokémon selected.</p>,
          onSome: ({ id, searchText }) => (
            <>
              <p>Selected Pokémon id: {id}</p>

              <input
                value={searchText}
                onChange={(event) => send(SelectionEvents.UpdateSearchText({ value: event.target.value }))}
              />

              {SelectionStates.matches(state.value, "form.Selected.Searching") && <p>Searching…</p>}

              {SelectionStates.get(state.value, "form.Selected.WithPokemon").pipe(
                Option.match({
                  onNone: () => null,
                  onSome: ({ pokemon }) => (
                    <article>
                      <h3>{pokemon.name}</h3>
                      <img src={pokemon.sprites.front_default} alt={pokemon.name} />
                      <button type="button" onClick={() => send(SelectionEvents.ReplacePokemon())}>
                        Replace
                      </button>
                    </article>
                  )
                })
              )}
            </>
          )
        })
      )}
    </section>
  )
}

function Replace() {
  const stateResult = useAtomValue(replaceMachineAtom.state)

  if (AsyncResult.isInitial(stateResult)) {
    return <p>Starting replacement machine…</p>
  }

  if (AsyncResult.isFailure(stateResult)) {
    return <p>Replacement machine failed.</p>
  }

  const state = stateResult.value

  if (Option.isNone(state)) {
    return null
  }

  return ReplaceStates.get(state.value, "Replacing").pipe(
    Option.match({
      onNone: () => null,
      onSome: ({ id }) => <p>Replacing Pokémon {id}…</p>
    })
  )
}

function PokemonGrid({ team }: { team: readonly (typeof Pokemon.Type)[] }) {
  const selected = useAtomValue(selectionMachineAtom.state)
  const replacing = useAtomValue(replaceMachineAtom.state)

  const sendSelection = useAtomSet(selectionMachineAtom.send)
  const sendReplace = useAtomSet(replaceMachineAtom.send)

  const selectedId = Match.value(selected).pipe(
    Match.tagsExhaustive({
      Initial: () => null,
      Failure: () => null,
      Success: (current) =>
        current.value.pipe(
          Option.flatMap((current) => SelectionStates.get(current, "form.Selected")),
          Option.map((current) => current.id),
          Option.getOrNull
        )
    })
  )

  const replacingId = Match.value(replacing).pipe(
    Match.tagsExhaustive({
      Initial: () => null,
      Failure: () => null,
      Success: (current) =>
        current.value.pipe(
          Option.flatMap((current) => ReplaceStates.get(current, "Replacing")),
          Option.map((current) => current.id),
          Option.getOrNull
        )
    })
  )

  return (
    <div className="pokemon-grid">
      {team.map((pokemon) => {
        const isSelected = pokemon.id === selectedId
        const isReplacing = pokemon.id === replacingId

        return (
          <div
            key={pokemon.id}
            className={`pokemon-card${isSelected ? " is-selected" : ""}${isReplacing ? " is-replacing" : ""}`}
          >
            <h3>{pokemon.name}</h3>
            <img src={pokemon.sprites.front_default} alt={pokemon.name} />
            <button
              type="button"
              onClick={() =>
                sendSelection(
                  SelectionEvents.SelectPokemon({
                    id: pokemon.id
                  })
                )}
            >
              Select
            </button>
            <button
              type="button"
              disabled={isReplacing}
              onClick={() => sendReplace(ReplaceEvents.ReplacePokemon({ id: pokemon.id }))}
            >
              Replace with random
            </button>
          </div>
        )
      })}
    </div>
  )
}

function MachinePage() {
  const snapshot = useAtomValue(machineAtom.snapshot)

  if (AsyncResult.isInitial(snapshot)) {
    return <p>Starting machine…</p>
  }

  if (AsyncResult.isFailure(snapshot)) {
    return <p>Machine failed to start.</p>
  }

  const state = snapshot.value.state

  return (
    <section className="machine-page">
      <h1>Machine</h1>
      <h3>Status: {snapshot.value.status}</h3>
      <h3>State: {state.path}</h3>

      <Selection />
      <Replace />

      {States.get(state, "ActiveTeam").pipe(
        Option.match({
          onNone: () => <p>No team selected</p>,
          onSome: ({ team }) => <PokemonGrid team={team} />
        })
      )}
    </section>
  )
}

const routeTree = rootRoute.addChildren([homeRoute, machineRoute])

export const router = createRouter({ routeTree })

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
