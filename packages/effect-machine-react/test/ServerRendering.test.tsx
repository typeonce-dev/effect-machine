// @vitest-environment jsdom
import { RegistryContext } from "@effect/atom-react"
import { act, cleanup, render, screen } from "@testing-library/react"
import { Context, Deferred, Effect, Layer, Schema } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import * as React from "react"
import { hydrateRoot } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { afterEach, assert, it, vi } from "vitest"
import { Machine } from "../../effect-machine/src/index.js"
import { AtomMachine } from "../../effect-machine/src/unstable/reactivity/index.js"
import { createMachineContext, MachineState } from "../src/index.js"

class Analytics extends Context.Service<Analytics, {
  readonly started: Effect.Effect<void>
}>()("test/ServerRendering/Analytics") {}

const Events = Machine.events({ Changed: { email: Schema.String } })

const makeOnboarding = () => {
  const counter = { started: 0 }
  const machine = Machine.make({
    root: Machine.state({
      fields: { seed: Schema.String },
      states: { Editing: { fields: { email: Schema.String } }, Saved: {} }
    }),
    events: Events,
    input: Schema.String,
    effects: {
      track: Effect.sync(() => {
        counter.started++
      }).pipe(Effect.andThen(Effect.never))
    }
  }).handle({
    root: ({ input }) => ({ seed: input }),
    initial: { target: "Editing", data: ({ root }) => ({ email: root.seed }) },
    states: {
      Editing: {
        invoke: { src: "track" },
        on: { Changed: { target: "Editing", data: ({ event }) => ({ email: event.email }) } }
      },
      Saved: {}
    }
  })
  return { counter, machine }
}

const makeAnalyticsOnboarding = () =>
  Machine.make({
    root: Machine.state({ states: { Editing: { fields: { email: Schema.String } } } }),
    events: Events,
    effects: {
      track: Effect.gen(function*() {
        const analytics = yield* Analytics
        yield* analytics.started
        return yield* Effect.never
      })
    }
  }).handle({
    initial: { target: "Editing", data: { email: "planned@example.com" } },
    states: {
      Editing: {
        invoke: { src: "track" },
        on: { Changed: { target: "Editing", data: ({ event }) => ({ email: event.email }) } }
      }
    }
  })

afterEach(cleanup)

// React warns about an uncached server snapshot only once per module, so every
// hydration asserts that the warning is absent.
const hydrate = async (container: HTMLElement, element: React.ReactNode) => {
  const recoverable: Array<unknown> = []
  const consoleError = vi.spyOn(console, "error")
  try {
    const root = await act(async () =>
      hydrateRoot(container, element, {
        onRecoverableError: (error) => {
          recoverable.push(error)
        }
      })
    )
    const serverSnapshotWarnings = consoleError.mock.calls.filter((args) =>
      args.some((arg) => String(arg).includes("getServerSnapshot"))
    )
    assert.deepStrictEqual(serverSnapshotWarnings, [])
    return { recoverable, root }
  } finally {
    consoleError.mockRestore()
  }
}

it("renders the planned snapshot on the server and hydrates into the live machine", async () => {
  const { counter, machine } = makeOnboarding()
  const Onboarding = createMachineContext(AtomMachine.factory(machine))
  let bridge: ReturnType<typeof Onboarding.useMachine> | undefined
  function EmailField() {
    bridge = Onboarding.useMachine()
    return (
      <MachineState machine={bridge} path="Editing" pending={<span>pending</span>}>
        {(editing) => <input value={editing.value.email} onChange={() => {}} />}
      </MachineState>
    )
  }
  const tree = (registry: AtomRegistry.AtomRegistry) => (
    <RegistryContext.Provider value={registry}>
      <Onboarding.Provider input="ada@example.com">
        <EmailField />
      </Onboarding.Provider>
    </RegistryContext.Provider>
  )

  const serverRegistry = AtomRegistry.make()
  const html = renderToString(tree(serverRegistry))
  assert.strictEqual(html, "<input value=\"ada@example.com\"/>")
  assert.strictEqual(counter.started, 0)
  serverRegistry.dispose()

  const container = document.createElement("div")
  document.body.appendChild(container)
  container.innerHTML = html
  const input = container.querySelector("input")!
  input.focus()

  const clientRegistry = AtomRegistry.make()
  const { recoverable, root } = await hydrate(container, tree(clientRegistry))
  assert.deepStrictEqual(recoverable, [])
  assert.strictEqual(counter.started, 1)
  assert.strictEqual(container.querySelector("input"), input)
  assert.strictEqual(document.activeElement, input)

  await act(async () => {
    clientRegistry.set(bridge!.send, Events.Changed({ email: "grace@example.com" }))
  })
  assert.strictEqual(container.querySelector("input"), input)
  assert.strictEqual(input.value, "grace@example.com")
  assert.strictEqual(document.activeElement, input)
  assert.strictEqual(counter.started, 1)

  await act(async () => root.unmount())
  container.remove()
  clientRegistry.dispose()
})

it("keeps the hydrated tree while a bound runtime is still building", async () => {
  const release = Effect.runSync(Deferred.make<void>())
  let started = 0
  const layer = Layer.effect(
    Analytics,
    Deferred.await(release).pipe(Effect.as(Analytics.of({ started: Effect.sync(() => started++) })))
  )
  const Onboarding = createMachineContext(
    AtomMachine.bind(Atom.runtime(layer)).factory(makeAnalyticsOnboarding())
  )
  let bridge: ReturnType<typeof Onboarding.useMachine> | undefined
  function EmailField() {
    bridge = Onboarding.useMachine()
    return (
      <MachineState machine={bridge} path="Editing" pending={<span>pending</span>}>
        {(editing) => <input value={editing.value.email} onChange={() => {}} />}
      </MachineState>
    )
  }
  const tree = (registry: AtomRegistry.AtomRegistry) => (
    <RegistryContext.Provider value={registry}>
      <Onboarding.Provider>
        <EmailField />
      </Onboarding.Provider>
    </RegistryContext.Provider>
  )

  const serverRegistry = AtomRegistry.make()
  const html = renderToString(tree(serverRegistry))
  assert.strictEqual(html, "<input value=\"planned@example.com\"/>")
  serverRegistry.dispose()

  const container = document.createElement("div")
  document.body.appendChild(container)
  container.innerHTML = html
  const input = container.querySelector("input")!

  const clientRegistry = AtomRegistry.make()
  const { recoverable, root } = await hydrate(container, tree(clientRegistry))
  assert.deepStrictEqual(recoverable, [])
  assert.strictEqual(started, 0)
  assert.strictEqual(container.querySelector("input"), input)
  assert.strictEqual(input.value, "planned@example.com")

  await act(async () => {
    clientRegistry.set(bridge!.send, Events.Changed({ email: "live@example.com" }))
    Effect.runSync(Deferred.succeed(release, undefined))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  assert.strictEqual(started, 1)
  assert.strictEqual(container.querySelector("input"), input)
  assert.strictEqual(input.value, "live@example.com")

  await act(async () => root.unmount())
  container.remove()
  clientRegistry.dispose()
})

it("renders pending until a client-only machine has a snapshot", async () => {
  const release = Effect.runSync(Deferred.make<void>())
  const layer = Layer.effect(
    Analytics,
    Deferred.await(release).pipe(Effect.as(Analytics.of({ started: Effect.void })))
  )
  const Onboarding = createMachineContext(
    AtomMachine.bind(Atom.runtime(layer)).factory(makeAnalyticsOnboarding())
  )
  function EmailField() {
    return (
      <MachineState machine={Onboarding.useMachine()} path="Editing" pending={<span>pending</span>}>
        {(editing) => <span>{editing.value.email}</span>}
      </MachineState>
    )
  }
  const registry = AtomRegistry.make()
  render(
    <RegistryContext.Provider value={registry}>
      <Onboarding.Provider>
        <EmailField />
      </Onboarding.Provider>
    </RegistryContext.Provider>
  )
  await screen.findByText("pending")
  await act(async () => {
    Effect.runSync(Deferred.succeed(release, undefined))
  })
  await screen.findByText("planned@example.com")
  registry.dispose()
})

it("renders nothing on the server for a machine that cannot be planned and fails on the client", async () => {
  const { counter, machine } = makeOnboarding()
  const Onboarding = createMachineContext(AtomMachine.factory(machine))
  let caught: unknown
  class Boundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
    state = { failed: false }
    static getDerivedStateFromError(error: unknown) {
      caught = error
      return { failed: true }
    }
    render() {
      return this.state.failed ? <span>startup failed</span> : this.props.children
    }
  }
  function EmailField() {
    return (
      <MachineState machine={Onboarding.useMachine()} path="Editing">
        {(editing) => <span>{editing.value.email}</span>}
      </MachineState>
    )
  }
  const tree = (registry: AtomRegistry.AtomRegistry) => (
    <RegistryContext.Provider value={registry}>
      <Onboarding.Provider input={42 as unknown as string}>
        <Boundary>
          <EmailField />
        </Boundary>
      </Onboarding.Provider>
    </RegistryContext.Provider>
  )
  const serverRegistry = AtomRegistry.make()
  assert.strictEqual(renderToString(tree(serverRegistry)), "")
  serverRegistry.dispose()

  const registry = AtomRegistry.make()
  render(tree(registry))
  await screen.findByText("startup failed")
  assert.isDefined(caught)
  assert.strictEqual(counter.started, 0)
  registry.dispose()
})
