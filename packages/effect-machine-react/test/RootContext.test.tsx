// @vitest-environment jsdom
import { RegistryContext } from "@effect/atom-react"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { Context, Effect, Layer, Schema } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import * as React from "react"
import { afterEach, expect, it } from "vitest"
import { Machine } from "../../effect-machine/src/index.js"
import { AtomMachine } from "../../effect-machine/src/unstable/reactivity/index.js"
import { createMachineContext, MachineState } from "../src/index.js"
const Events = Machine.events({ Increment: {}, Close: {} })
const root1 = Machine.state({ fields: { count: Schema.Number }, states: { Open: {}, Closed: {} } })
const counter = Machine.make({
  root: root1,
  events: Events,
  input: Schema.Number
}).handle({
  initial: {
    target: "Open"
  },
  root: ({ input }) => ({ count: input }),
  on: { Increment: { update: "root", data: ({ root: current }) => ({ count: current.count + 1 }) } },
  states: {
    Open: { on: { Close: { target: "Closed" } } },
    Closed: {}
  }
})
const Counter = createMachineContext(AtomMachine.factory(counter))
afterEach(cleanup)
it("keeps a provider's input and bridge stable until its React key changes", async () => {
  const registry = AtomRegistry.make({ defaultIdleTTL: 1 })
  let bridge: ReturnType<typeof Counter.useMachine> | undefined
  let readers = 0
  function Reader() {
    readers++
    bridge = Counter.useMachine()
    return (
      <React.Suspense fallback="starting">
        <MachineState machine={bridge} path="">
          {(root) => <span data-testid="count">{root.value.count}</span>}
        </MachineState>
        <MachineState machine={bridge} path="Open" inactive={<span>closed</span>}>
          {() => <span>open</span>}
        </MachineState>
      </React.Suspense>
    )
  }
  const tree = (input: number, id: string) => (
    <RegistryContext.Provider value={registry}>
      <React.StrictMode>
        <Counter.Provider input={input} key={id}>
          <Reader />
        </Counter.Provider>
      </React.StrictMode>
    </RegistryContext.Provider>
  )
  const view = render(tree(1, "first"))
  await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("1"))
  const first = bridge!
  const renders = readers
  await act(async () => {
    registry.set(first.send, Events.Increment())
  })
  await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("2"))
  expect(readers).toBe(renders)
  await act(async () => {
    registry.set(first.send, Events.Close())
  })
  await screen.findByText("closed")
  view.rerender(tree(99, "first"))
  expect(bridge).toBe(first)
  expect(screen.getByTestId("count").textContent).toBe("2")
  view.rerender(tree(9, "second"))
  await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("9"))
  expect(bridge).not.toBe(first)
  await screen.findByText("open")
  view.unmount()
  registry.dispose()
})
it("keeps independent providers isolated in the same registry", async () => {
  const registry = AtomRegistry.make()
  const bridges: Array<ReturnType<typeof Counter.useMachine>> = []
  function Reader({ index }: {
    readonly index: number
  }) {
    const machine = Counter.useMachine()
    bridges[index] = machine
    return (
      <React.Suspense>
        <MachineState machine={machine} path="">
          {(root) => <span data-testid={`count-${index}`}>{root.value.count}</span>}
        </MachineState>
      </React.Suspense>
    )
  }
  const view = render(
    <RegistryContext.Provider value={registry}>
      <Counter.Provider input={1}>
        <Reader index={0} />
      </Counter.Provider>
      <Counter.Provider input={1}>
        <Reader index={1} />
      </Counter.Provider>
    </RegistryContext.Provider>
  )
  await screen.findByTestId("count-1")
  expect(bridges[0]).not.toBe(bridges[1])
  await act(async () => {
    registry.set(bridges[0]!.send, Events.Increment())
  })
  await waitFor(() => expect(screen.getByTestId("count-0").textContent).toBe("2"))
  expect(screen.getByTestId("count-1").textContent).toBe("1")
  view.unmount()
  registry.dispose()
})
it("sends startup failures from a state renderer to an error boundary", async () => {
  const registry = AtomRegistry.make()
  let caught: unknown
  class Boundary extends React.Component<React.PropsWithChildren, {
    failed: boolean
  }> {
    state = { failed: false }
    static getDerivedStateFromError(error: unknown) {
      caught = error
      return { failed: true }
    }
    render() {
      return this.state.failed ? <span>startup failed</span> : this.props.children
    }
  }
  function Reader() {
    return <MachineState machine={Counter.useMachine()} path="">{() => <span>ready</span>}</MachineState>
  }
  const view = render(
    <RegistryContext.Provider value={registry}>
      <Counter.Provider input={"invalid" as unknown as number}>
        <Boundary>
          <React.Suspense fallback="starting">
            <Reader />
          </React.Suspense>
        </Boundary>
      </Counter.Provider>
    </RegistryContext.Provider>
  )
  await screen.findByText("startup failed")
  expect(caught).toBeDefined()
  expect(screen.queryByText("ready")).toBeNull()
  view.unmount()
  registry.dispose()
})

class Navigation extends Context.Service<Navigation, {
  readonly push: (href: string) => Effect.Effect<void>
}>()("test/RootContext/Navigation") {}
const leaving = Machine.make({
  root: Machine.state({ fields: { redirect: Schema.String }, states: { Leaving: {}, Left: {} } }),
  events: Machine.events({}),
  input: Schema.String,
  effects: {
    navigate: ({ root }: { readonly root: { readonly redirect: string } }) =>
      Effect.flatMap(Navigation, (navigation) => navigation.push(root.redirect))
  }
}).handle({
  root: ({ input }) => ({ redirect: input }),
  initial: { target: "Leaving" },
  states: {
    Leaving: { invoke: { src: "navigate", input: ({ root }) => ({ root }), onDone: { target: "Left" } } },
    Left: {}
  }
})
const Leave = createMachineContext((input: string, navigation: Layer.Layer<Navigation>) =>
  AtomMachine.bind(Atom.runtime(navigation)).make(leaving, input)
)
it("provides each owner's capability layer to its machine", async () => {
  const registry = AtomRegistry.make()
  const pushed: Array<string> = []
  const navigation = (router: string) =>
    Layer.succeed(Navigation, {
      push: (href) => Effect.sync(() => pushed.push(`${router}:${href}`))
    })
  function Reader({ name }: { readonly name: string }) {
    return (
      <MachineState machine={Leave.useMachine()} path="Left">
        {() => <span>{name} left</span>}
      </MachineState>
    )
  }
  const view = render(
    <RegistryContext.Provider value={registry}>
      <Leave.Provider input="/a" layer={navigation("first")}>
        <Reader name="first" />
      </Leave.Provider>
      <Leave.Provider input="/b" layer={navigation("second")}>
        <Reader name="second" />
      </Leave.Provider>
    </RegistryContext.Provider>
  )
  await screen.findByText("first left")
  await screen.findByText("second left")
  expect([...pushed].sort()).toEqual(["first:/a", "second:/b"])
  view.unmount()
  registry.dispose()
})
it("reads the capability layer once when the owner mounts", async () => {
  const registry = AtomRegistry.make()
  const pushed: Array<string> = []
  const navigation = (router: string) =>
    Layer.succeed(Navigation, {
      push: (href) => Effect.sync(() => pushed.push(`${router}:${href}`))
    })
  const NoInput = createMachineContext((_: void, layer: Layer.Layer<Navigation>) =>
    AtomMachine.bind(Atom.runtime(layer)).make(leaving, "/home")
  )
  let bridge: ReturnType<typeof NoInput.useMachine> | undefined
  function Reader() {
    bridge = NoInput.useMachine()
    return (
      <MachineState machine={bridge} path="Left">
        {() => <span>left</span>}
      </MachineState>
    )
  }
  const tree = (router: string, key: string) => (
    <RegistryContext.Provider value={registry}>
      <NoInput.Provider layer={navigation(router)} key={key}>
        <Reader />
      </NoInput.Provider>
    </RegistryContext.Provider>
  )
  const view = render(tree("first", "a"))
  await screen.findByText("left")
  const first = bridge
  view.rerender(tree("second", "a"))
  expect(bridge).toBe(first)
  expect(pushed).toEqual(["first:/home"])
  view.rerender(tree("third", "b"))
  await waitFor(() => expect(pushed).toEqual(["first:/home", "third:/home"]))
  expect(bridge).not.toBe(first)
  view.unmount()
  registry.dispose()
})
