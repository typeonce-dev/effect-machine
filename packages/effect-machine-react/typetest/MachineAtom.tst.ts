import { Context, Effect, Layer, Schema } from "effect"
import type { AsyncResult } from "effect/reactivity"
import { Atom } from "effect/reactivity"
import type * as React from "react"
import { expect } from "tstyche"
import { Machine } from "../../effect-machine/src/index.js"
import { AtomMachine } from "../../effect-machine/src/unstable/reactivity/index.js"
import type { MachineStateProps } from "../src/index.js"
import { createMachineContext, MachineState, useMachineAtom, useMachineResult } from "../src/index.js"
class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
class Continue extends Schema.TaggedClass<Continue>("Continue")("Continue", {}) {}
const States = Machine.state({ states: { Idle } })
const machine = Machine.make({
  root: States,
  events: Machine.eventsFromSchemas(Continue)
}).handle({
  initial: {
    target: "Idle",
    decoded: true,
    data: new Idle({})
  },
  states: {
    Idle: {
      on: {
        Continue: { none: true }
      }
    }
  }
})
const expected = AtomMachine.make(machine)
const owned = useMachineAtom(() => AtomMachine.make(machine))
expect(owned).type.toBe<typeof expected>()
const Root = Machine.state({
  fields: { count: Schema.Number },
  states: { Editing: { fields: { draft: Schema.String } }, Closed: {} }
})
const withInput = Machine.make({
  root: Root,
  input: Schema.Number,
  events: Machine.events({ Close: {} })
}).handle({
  initial: {
    target: "Editing",
    data: ({}) => ({ draft: "" })
  },
  root: ({ input }) => ({ count: input }),
  states: { Editing: {}, Closed: {} }
})
const InputContext = createMachineContext(({ input }: { input: number }) => AtomMachine.make(withInput, input))
const NoInputContext = createMachineContext(AtomMachine.factory(machine))
type InputProps = React.ComponentProps<typeof InputContext.Provider>
type NoInputProps = React.ComponentProps<typeof NoInputContext.Provider>
expect<InputProps["input"]>().type.toBe<number>()
expect<{}>().type.not.toBeAssignableTo<InputProps>()
expect<{
  input: string
}>().type.not.toBeAssignableTo<InputProps>()
expect<{
  input: number
}>().type.not.toBeAssignableTo<NoInputProps>()
expect<{}>().type.toBeAssignableTo<NoInputProps>()
const contextBridge = InputContext.useMachine()
const inputFactory = AtomMachine.factory(withInput)
expect(contextBridge).type.toBe<ReturnType<typeof inputFactory>>()
MachineState({
  machine: contextBridge,
  path: "Editing",
  children: (snapshot) => {
    expect(snapshot.path).type.toBe<"Editing">()
    expect(snapshot.value.draft).type.toBe<string>()
    expect(snapshot.value).type.not.toHaveProperty("count")
    return null
  }
})
MachineState({
  machine: contextBridge,
  path: "",
  children: (snapshot) => {
    expect(snapshot.value.count).type.toBe<number>()
    return null
  }
})
expect(MachineState).type.not.toBeCallableWith({ machine: contextBridge, path: "Missing", children: () => null })
expect(MachineState).type.toBeCallableWith({
  machine: contextBridge,
  path: "Editing",
  pending: "starting",
  inactive: null,
  children: () => null
})
const Quantity = Machine.make({
  root: Machine.state({
    fields: { quantity: Schema.Number },
    states: { Counting: { fields: { step: Schema.Number } }, Locked: {} }
  }),
  events: Machine.events({ Lock: {} })
}).handle({
  root: { quantity: 1 },
  initial: { target: "Counting", data: { step: 1 } },
  states: { Counting: {}, Locked: {} }
})
const QuantityChild = Machine.child("quantity", Quantity)
const Cart = Machine.make({
  root: Machine.state({ states: { Shopping: {}, Paid: {} } }),
  events: Machine.events({ Pay: {} }),
  children: { quantity: QuantityChild }
}).handle({
  initial: { target: "Shopping" },
  states: { Shopping: { invoke: { src: "quantity" } }, Paid: {} }
})
const cart = AtomMachine.make(Cart)
const quantity = cart.child(QuantityChild)
MachineState({
  machine: quantity,
  path: "",
  children: (snapshot) => {
    expect(snapshot.path).type.toBe<"">()
    expect(snapshot.value.quantity).type.toBe<number>()
    return null
  }
})
MachineState({
  machine: quantity,
  path: "Counting",
  inactive: null,
  children: (snapshot) => {
    expect(snapshot.path).type.toBe<"Counting">()
    expect(snapshot.value.step).type.toBe<number>()
    expect(snapshot.value).type.not.toHaveProperty("quantity")
    return null
  }
})
expect<Parameters<MachineStateProps<typeof quantity, "Locked">["children"]>[0]>().type.toBe<
  Machine.Snapshot.At<AtomMachine.ChildMachineAtom.State<typeof quantity>, "Locked">
>()
expect(MachineState).type.not.toBeCallableWith({ machine: quantity, path: "Shopping", children: () => null })
expect(MachineState).type.not.toBeCallableWith({ machine: cart, path: "Counting", children: () => null })
expect(useMachineResult(AtomMachine.matches(cart, "Paid"))).type.toBe<
  AsyncResult.AsyncResult<boolean, Atom.Failure<typeof cart.result>>
>()

class Navigation extends Context.Service<Navigation, {
  readonly push: (href: string) => Effect.Effect<void>
}>()("typetest/Navigation") {}
class Clock extends Context.Service<Clock, { readonly now: Effect.Effect<number> }>()("typetest/Clock") {}
const Leaving = Machine.make({
  root: Machine.state({ fields: { redirect: Schema.String }, states: { Leaving: {}, Done: { type: "final" } } }),
  input: Schema.String,
  events: Machine.events({}),
  effects: { navigate: Effect.flatMap(Navigation, (navigation) => navigation.push("/next")) }
}).handle({
  root: ({ input }) => ({ redirect: input }),
  initial: { target: "Leaving" },
  states: { Leaving: { invoke: { src: "navigate", onDone: { target: "Done" } } }, Done: {} }
})
const LayerContext = createMachineContext(({ input, layer }: { input: string; layer: Layer.Layer<Navigation> }) =>
  AtomMachine.bind(Atom.runtime(layer)).make(Leaving, input)
)
type LayerProps = React.ComponentProps<typeof LayerContext.Provider>
expect<LayerProps["layer"]>().type.toBe<Layer.Layer<Navigation>>()
expect<LayerProps["input"]>().type.toBe<string>()
expect<{ input: string }>().type.not.toBeAssignableTo<LayerProps>()
expect<{ input: string; layer: Layer.Layer<Clock> }>().type.not.toBeAssignableTo<LayerProps>()
expect<{ input: string; layer: Layer.Layer<Navigation> }>().type.toBeAssignableTo<LayerProps>()
expect<{ layer: Layer.Layer<never> }>().type.not.toBeAssignableTo<InputProps>()
expect<{ layer: Layer.Layer<never> }>().type.not.toBeAssignableTo<NoInputProps>()
const LayerOnlyContext = createMachineContext(({ layer }: { layer: Layer.Layer<Navigation> }) =>
  AtomMachine.bind(Atom.runtime(layer)).make(Leaving, "/")
)
type LayerOnlyProps = React.ComponentProps<typeof LayerOnlyContext.Provider>
expect<{ layer: Layer.Layer<Navigation> }>().type.toBeAssignableTo<LayerOnlyProps>()
expect<{ input: string; layer: Layer.Layer<Navigation> }>().type.not.toBeAssignableTo<LayerOnlyProps>()
expect<{}>().type.not.toBeAssignableTo<LayerOnlyProps>()
expect(
  ({ input, layer }: { input: string; layer: Layer.Layer<Clock> }) =>
    AtomMachine.bind(Atom.runtime(layer)).make(Leaving, input)
).type.toRaiseError()
// A factory that takes input positionally would receive the options object.
expect(createMachineContext).type.not.toBeCallableWith(AtomMachine.factory(withInput))
// Capabilities travel as `layer`, never under another option name.
expect(createMachineContext).type.not.toBeCallableWith(
  ({ input }: { input: number; router: string }) => AtomMachine.make(withInput, input)
)
