// @vitest-environment jsdom

import { RegistryContext, useAtomSuspense } from "@effect/atom-react"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { Effect, Option, Schema } from "effect"
import { AtomRegistry } from "effect/unstable/reactivity"
import * as React from "react"
import { renderToString } from "react-dom/server"
import { afterEach, assert, describe, it } from "vitest"
import { Machine } from "../../effect-machine/src/index.js"
import { AtomMachine } from "../../effect-machine/src/unstable/reactivity/index.js"
import { useMachineAtom } from "../src/index.js"

class Active extends Schema.TaggedClass<Active>("Active")("Active", {
  value: Schema.Number
}) {}
class Increment extends Schema.TaggedClass<Increment>("Increment")("Increment", {}) {}

const States = Machine.states({ Active })

const trackedMachine = (onStart: () => void) =>
  Machine.make({
    states: States.states,
    events: Machine.events(Increment),
    input: Schema.Number,
    initial: (to) =>
      to.Active().resolve(({ input, target }) => {
        onStart()
        return target.decoded(new Active({ value: input }))
      })
  }).handle({
    Active: {
      on: {
        Increment: (to) =>
          to.full.Active().resolve(({ state, target }) => target.decoded(new Active({ value: state.value + 1 })))
      }
    }
  })

afterEach(cleanup)

describe("useMachineAtom", () => {
  it("keeps the owner unsubscribed while a state-path reader updates", async () => {
    const machine = trackedMachine(() => {})
    const registry = AtomRegistry.make({ defaultIdleTTL: 1_000 })
    const makeOwned = () => AtomMachine.make(machine, 0)
    let current: ReturnType<typeof makeOwned> | undefined
    let ownerRenders = 0
    let readerRenders = 0

    function Reader({ owned }: { readonly owned: NonNullable<typeof current> }) {
      readerRenders++
      const active = useAtomSuspense(AtomMachine.select(owned, "Active")).value
      return <span data-testid="value">{Option.getOrThrow(active).value}</span>
    }

    function Owner() {
      ownerRenders++
      const owned = useMachineAtom(() => AtomMachine.make(machine, 0))
      current = owned
      return (
        <React.Suspense fallback="starting">
          <Reader owned={owned} />
        </React.Suspense>
      )
    }

    const view = render(
      <RegistryContext.Provider value={registry}>
        <Owner />
      </RegistryContext.Provider>
    )

    await waitFor(() => assert.strictEqual(screen.getByTestId("value").textContent, "0"))
    const initialOwnerRenders = ownerRenders
    const initialReaderRenders = readerRenders

    await act(() => {
      registry.set(current!.send, new Increment({}))
    })

    await waitFor(() => assert.strictEqual(screen.getByTestId("value").textContent, "1"))
    assert.strictEqual(ownerRenders, initialOwnerRenders)
    assert.ok(readerRenders > initialReaderRenders)

    view.unmount()
    registry.dispose()
  })

  it("owns one committed machine without making startup input reactive", async () => {
    let starts = 0
    const machine = trackedMachine(() => {
      starts++
    })
    const makeOwned = (input: number) => AtomMachine.make(machine, input)
    let current: ReturnType<typeof makeOwned> | undefined
    const registry = AtomRegistry.make({ defaultIdleTTL: 1_000 })

    function Owner({ input }: { readonly input: number }) {
      const owned = useMachineAtom(() => AtomMachine.make(machine, input))
      React.useEffect(() => {
        current = owned
      }, [owned])
      return null
    }

    const view = render(
      <RegistryContext.Provider value={registry}>
        <React.StrictMode>
          <Owner input={1} />
        </React.StrictMode>
      </RegistryContext.Provider>
    )

    await waitFor(() => assert.strictEqual(starts, 1))
    const first = current!
    assert.deepStrictEqual(await Effect.runPromise(AtomRegistry.getResult(registry, first.result)), {
      path: "Active",
      value: new Active({ value: 1 })
    })

    view.rerender(
      <RegistryContext.Provider value={registry}>
        <React.StrictMode>
          <Owner input={2} />
        </React.StrictMode>
      </RegistryContext.Provider>
    )

    assert.strictEqual(current, first)
    assert.strictEqual(starts, 1)
    assert.strictEqual((await Effect.runPromise(AtomRegistry.getResult(registry, first.result))).value.value, 1)

    view.rerender(
      <RegistryContext.Provider value={registry}>
        <React.StrictMode>
          <Owner key="replacement" input={2} />
        </React.StrictMode>
      </RegistryContext.Provider>
    )

    await waitFor(() => assert.strictEqual(starts, 2))
    assert.notStrictEqual(current, first)
    assert.strictEqual((await Effect.runPromise(AtomRegistry.getResult(registry, current!.result))).value.value, 2)

    view.unmount()
    registry.dispose()
  })

  it("runs the same machine atom independently in each registry", async () => {
    let starts = 0
    const machine = trackedMachine(() => {
      starts++
    })
    const bridge = AtomMachine.make(machine, 1)
    const firstRegistry = AtomRegistry.make({ defaultIdleTTL: 1_000 })
    const secondRegistry = AtomRegistry.make({ defaultIdleTTL: 1_000 })

    function Owner() {
      useMachineAtom(() => bridge)
      return null
    }

    const view = render(
      <>
        <RegistryContext.Provider value={firstRegistry}>
          <Owner />
        </RegistryContext.Provider>
        <RegistryContext.Provider value={secondRegistry}>
          <Owner />
        </RegistryContext.Provider>
      </>
    )

    await waitFor(() => assert.strictEqual(starts, 2))
    const first = await Effect.runPromise(AtomRegistry.getResult(firstRegistry, bridge.ref))
    const second = await Effect.runPromise(AtomRegistry.getResult(secondRegistry, bridge.ref))
    assert.notStrictEqual(first, second)

    view.unmount()
    firstRegistry.dispose()
    secondRegistry.dispose()
  })

  it("releases its mount when the owner unmounts", async () => {
    const machine = trackedMachine(() => {})
    const registry = AtomRegistry.make({ defaultIdleTTL: 0, timeoutResolution: 1 })
    const makeOwned = () => AtomMachine.make(machine, 1)
    let current: ReturnType<typeof makeOwned> | undefined

    function Owner() {
      const owned = useMachineAtom(() => AtomMachine.make(machine, 1))
      React.useEffect(() => {
        current = owned
      }, [owned])
      return null
    }

    const view = render(
      <RegistryContext.Provider value={registry}>
        <Owner />
      </RegistryContext.Provider>
    )

    await waitFor(() => assert.ok(current !== undefined))
    const ref = await Effect.runPromise(AtomRegistry.getResult(registry, current!.ref))
    view.unmount()

    await waitFor(async () => {
      assert.strictEqual((await Effect.runPromise(ref.snapshot)).status, "stopped")
    })
    registry.dispose()
  })

  it("does not start the machine during server rendering", () => {
    let starts = 0
    const machine = trackedMachine(() => {
      starts++
    })
    const registry = AtomRegistry.make()

    function Owner() {
      useMachineAtom(() => AtomMachine.make(machine, 1))
      return null
    }

    renderToString(
      <RegistryContext.Provider value={registry}>
        <Owner />
      </RegistryContext.Provider>
    )

    assert.strictEqual(starts, 0)
    registry.dispose()
  })
})
