// @vitest-environment jsdom
import { RegistryContext } from "@effect/atom-react"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { Schema } from "effect"
import { AtomRegistry } from "effect/unstable/reactivity"
import * as React from "react"
import { afterEach, expect, it } from "vitest"
import { Machine } from "../../effect-machine/src/index.js"
import { AtomMachine } from "../../effect-machine/src/unstable/reactivity/index.js"
import { createMachineContext, MachineState } from "../src/index.js"
const Events = Machine.events({ Increment: {}, Close: {} })
const root1 = Machine.state({ fields: { count: Schema.Number }, states: { Open: {}, Closed: {} } })
const targets1 = Machine.targets(root1)
const counter = Machine.make({
  root: root1,
  events: Events,
  input: Schema.Number
}).handle({
  initial: {
    target: Machine.targets(root1).root.Open
  },
  root: ({ input }) => ({ count: input }),
  on: { Increment: { update: targets1.root, data: ({ root: current }) => ({ count: current.count + 1 }) } },
  states: {
    Open: { on: { Close: { target: targets1.root.Closed } } },
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
