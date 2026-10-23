// @vitest-environment jsdom
import { RegistryContext, useAtomSet, useAtomSuspense } from "@effect/atom-react"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { Effect, Equal, Layer, Option, Schema } from "effect"
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity"
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
const States = Machine.state({ fields: { seed: Schema.Number }, states: { Active } })
const trackedMachine = (onStart: () => void) => {
  return Machine.make({
    root: States,
    events: Machine.eventsFromSchemas(Increment),
    input: Schema.Number
  }).handle({
    root: ({ input }) => ({ seed: input }),
    initial: { target: "Active", data: ({ root }) => ({ value: root.seed }) },
    entry: () => {
      onStart()
      return undefined
    },
    states: {
      Active: {
        on: {
          Increment: {
            target: "Active",
            decoded: true,
            data: ({ state }) => (new Active({ value: state.value + 1 }))
          }
        }
      }
    }
  })
}
afterEach(cleanup)
describe("useMachineAtom", () => {
  it("keeps the owner unsubscribed while a state-path reader updates", async () => {
    const machine = trackedMachine(() => {})
    const registry = AtomRegistry.make({ defaultIdleTTL: 1000 })
    const makeOwned = () => AtomMachine.make(machine, 0)
    let current: ReturnType<typeof makeOwned> | undefined
    let ownerRenders = 0
    let readerRenders = 0
    function Reader({ owned }: {
      readonly owned: NonNullable<typeof current>
    }) {
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
  it("rerenders a field projection only when the projected value changes", async () => {
    const machine = trackedMachine(() => {})
    const registry = AtomRegistry.make({ defaultIdleTTL: 1000 })
    const makeOwned = () => AtomMachine.make(machine, 0)
    const reachedThreshold = Atom.family((owned: ReturnType<typeof makeOwned>) =>
      Atom.mapResult(AtomMachine.select(owned, "Active"), Option.map(({ value }) => value >= 2)).pipe(
        Atom.withEquality(Equal.equals)
      )
    )
    let current: ReturnType<typeof makeOwned> | undefined
    let readerRenders = 0
    function Reader({ owned }: {
      readonly owned: ReturnType<typeof makeOwned>
    }) {
      readerRenders++
      const reached = useAtomSuspense(reachedThreshold(owned)).value
      return <span data-testid="reached">{String(Option.getOrThrow(reached))}</span>
    }
    function Owner() {
      const owned = useMachineAtom(makeOwned)
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
    await waitFor(() => assert.strictEqual(screen.getByTestId("reached").textContent, "false"))
    assert.strictEqual(reachedThreshold(current!), reachedThreshold(current!))
    const initialReaderRenders = readerRenders
    await act(() => {
      registry.set(current!.send, new Increment({}))
    })
    const active = registry.get(AtomMachine.select(current!, "Active"))
    assert.ok(AsyncResult.isSuccess(active))
    assert.strictEqual(Option.getOrThrow(active.value).value, 1)
    assert.strictEqual(readerRenders, initialReaderRenders)
    await act(() => {
      registry.set(current!.send, new Increment({}))
    })
    await waitFor(() => assert.strictEqual(screen.getByTestId("reached").textContent, "true"))
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
    const registry = AtomRegistry.make({ defaultIdleTTL: 1000 })
    function Owner({ input }: {
      readonly input: number
    }) {
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
    assert.deepStrictEqual((await Effect.runPromise(AtomRegistry.getResult(registry, first.result))).state, {
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
    assert.strictEqual((await Effect.runPromise(AtomRegistry.getResult(registry, first.result))).state.value.value, 1)
    view.rerender(
      <RegistryContext.Provider value={registry}>
        <React.StrictMode>
          <Owner key="replacement" input={2} />
        </React.StrictMode>
      </RegistryContext.Provider>
    )
    await waitFor(() => assert.strictEqual(starts, 2))
    assert.notStrictEqual(current, first)
    assert.strictEqual(
      (await Effect.runPromise(AtomRegistry.getResult(registry, current!.result))).state.value.value,
      2
    )
    view.unmount()
    registry.dispose()
  })
  it("runs the same machine atom independently in each registry", async () => {
    let starts = 0
    const machine = trackedMachine(() => {
      starts++
    })
    const bridge = AtomMachine.make(machine, 1)
    const firstRegistry = AtomRegistry.make({ defaultIdleTTL: 1000 })
    const secondRegistry = AtomRegistry.make({ defaultIdleTTL: 1000 })
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
  it("delivers events sent on first mount while a bound runtime is still building", async () => {
    const machine = trackedMachine(() => {})
    const runtime = Atom.runtime(Layer.effectDiscard(Effect.sleep("20 millis")))
    const registry = AtomRegistry.make()
    function Reader({ owned }: { readonly owned: AtomMachine.MachineAtom.Any }) {
      const active = useAtomSuspense(AtomMachine.matches(owned, "Active")).value
      return <span data-testid="active">{String(active)}</span>
    }
    function Owner() {
      const owned = useMachineAtom(() => AtomMachine.bind(runtime).make(machine, 3))
      const send = useAtomSet(owned.send)
      React.useEffect(() => {
        send(new Increment({}))
        send(new Increment({}))
      }, [send])
      const value = AtomMachine.select(owned, "Active")
      return (
        <React.Suspense fallback="starting">
          <Reader owned={owned} />
          <Value value={value} />
        </React.Suspense>
      )
    }
    function Value({ value }: {
      readonly value: Atom.Atom<AsyncResult.AsyncResult<Option.Option<Active>, unknown>>
    }) {
      const active = useAtomSuspense(value).value
      return <span data-testid="value">{Option.getOrThrow(active).value}</span>
    }
    render(
      <RegistryContext.Provider value={registry}>
        <Owner />
      </RegistryContext.Provider>
    )
    await waitFor(() => assert.strictEqual(screen.getByTestId("value").textContent, "5"))
    assert.strictEqual(screen.getByTestId("active").textContent, "true")
    registry.dispose()
  })
  it("keeps a controlled input bound to machine state in sync within the input event", async () => {
    class Editing extends Schema.TaggedClass<Editing>("ControlledEditing")("Editing", {
      value: Schema.String
    }) {}
    class Changed extends Schema.TaggedClass<Changed>("ControlledChanged")("Changed", {
      value: Schema.String
    }) {}
    const machine = Machine.make({
      root: Machine.state({ states: { Editing } }),
      events: Machine.eventsFromSchemas(Changed)
    }).handle({
      initial: { target: "Editing", decoded: true, data: new Editing({ value: "" }) },
      states: {
        Editing: {
          on: {
            Changed: { target: "Editing", decoded: true, data: ({ event }) => new Editing({ value: event.value }) }
          }
        }
      }
    })
    const registry = AtomRegistry.make({ defaultIdleTTL: 1000 })
    const makeOwned = () => AtomMachine.make(machine)
    function Field({ owned }: { readonly owned: ReturnType<typeof makeOwned> }) {
      const editing = useAtomSuspense(AtomMachine.select(owned, "Editing")).value
      const send = useAtomSet(owned.send)
      return (
        <input
          data-testid="field"
          value={Option.getOrThrow(editing).value}
          onChange={(event) => send(new Changed({ value: event.target.value }))}
        />
      )
    }
    function Owner() {
      const owned = useMachineAtom(makeOwned)
      return (
        <React.Suspense fallback="starting">
          <Field owned={owned} />
        </React.Suspense>
      )
    }
    const view = render(
      <RegistryContext.Provider value={registry}>
        <Owner />
      </RegistryContext.Provider>
    )
    const field = await waitFor(() => screen.getByTestId("field") as HTMLInputElement)
    // React restores a controlled input to its rendered value when the
    // handler leaves state unchanged, so each value must survive its event.
    const values: Array<string> = []
    for (const value of ["ac", "abc", "abbc"]) {
      fireEvent.change(field, { target: { value } })
      values.push(field.value)
    }
    assert.deepStrictEqual(values, ["ac", "abc", "abbc"])
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
    assert.strictEqual(field.value, "abbc")
    view.unmount()
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
