import { Schema } from "effect"
import type * as React from "react"
import { expect } from "tstyche"
import { Machine } from "../../effect-machine/src/index.js"
import { AtomMachine } from "../../effect-machine/src/unstable/reactivity/index.js"
import { createMachineContext, MachineState, useMachineAtom } from "../src/index.js"
class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
class Continue extends Schema.TaggedClass<Continue>("Continue")("Continue", {}) {}
const States = Machine.state({ states: { Idle } })
const machine = Machine.make({
  root: States,
  events: Machine.eventsFromSchemas(Continue)
}).handle({
  initial: {
    target: Machine.targets(States).root.Idle,
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
    target: Machine.targets(Root).root.Editing,
    data: ({}) => ({ draft: "" })
  },
  root: ({ input }) => ({ count: input }),
  states: { Editing: {}, Closed: {} }
})
const InputContext = createMachineContext(AtomMachine.factory(withInput))
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
