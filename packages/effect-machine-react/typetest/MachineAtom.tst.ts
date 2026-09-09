import { Schema } from "effect"
import type * as React from "react"
import { expect } from "tstyche"
import { Machine } from "../../effect-machine/src/index.js"
import { AtomMachine } from "../../effect-machine/src/unstable/reactivity/index.js"
import { createMachineContext, MachineState, useMachineAtom } from "../src/index.js"

class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
class Continue extends Schema.TaggedClass<Continue>("Continue")("Continue", {}) {}

const States = Machine.state({ initial: "Idle", states: { Idle } })

const machine = Machine.make({
  root: States,
  events: Machine.eventsFromSchemas(Continue),
  initialConfiguration: (root) => root.resolve(({ target }) => target.from((to) => to.Idle.decoded(new Idle({}))))
}).handle({
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
  initial: "Editing",
  states: { Editing: { fields: { draft: Schema.String } }, Closed: {} }
})
const withInput = Machine.make({
  root: Root,
  input: Schema.Number,
  events: Machine.events({ Close: {} }),
  initial: (root) => root.from(({ input }) => ({ count: input }))
}).handle({ initialize: ({ builder }) => builder.from({ draft: "" }) })
const InputContext = createMachineContext(AtomMachine.factory(withInput))
const NoInputContext = createMachineContext(AtomMachine.factory(machine))

type InputProps = React.ComponentProps<typeof InputContext.Provider>
type NoInputProps = React.ComponentProps<typeof NoInputContext.Provider>
expect<InputProps["input"]>().type.toBe<number>()
expect<{}>().type.not.toBeAssignableTo<InputProps>()
expect<{ input: string }>().type.not.toBeAssignableTo<InputProps>()
expect<{ input: number }>().type.not.toBeAssignableTo<NoInputProps>()
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
