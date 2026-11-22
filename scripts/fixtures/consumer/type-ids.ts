import { Machine } from "@typeonce/effect-machine"
import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { MachineTest } from "@typeonce/effect-machine/testing"
import { Effect, Schema } from "effect"

// A declaration that expands a public interface structurally prints every key
// of it, so no key of a public type may be a private constant.

const expand = <T>(value: T): { readonly [K in keyof T]: T[K] } => value
const sample = <T>(): T => undefined as never

export const declaration: Machine.StateDeclaration = {
  fields: { count: Schema.Number },
  states: { Idle: {}, Done: { type: "final" } }
}
export const States = Machine.state({
  fields: { count: Schema.Number },
  states: { Idle: {}, Busy: { states: { Working: {}, Paused: {} } }, Done: { type: "final" } }
})
export const Events = Machine.events({ Go: {}, Stop: {} })
export const definition = Machine.make({ root: States, events: Events, effects: { load: Effect.succeed(1) } })
export const machine = definition.handle({
  root: () => ({ count: 0 }),
  initial: { target: "Idle" },
  states: {
    Idle: { on: { Go: { target: "Busy" } } },
    Busy: { initial: { target: "Busy.Working" }, on: { Stop: { target: "Done" } } },
    Done: {}
  }
})
export const child = Machine.child("child", machine)

export const machineKeys = expand(machine)
export const childKeys = expand(child)
export const eventKeys = expand(Events)
export const eventConstructionKeys = expand(Events.Go())
export const noTargetKeys = expand(sample<Machine.Machine.NoTarget>())
export const declinedKeys = expand(sample<Machine.Machine.Declined>())
export const targetKeys = expand(sample<Machine.Machine.Target<Machine.Machine.States<typeof machine>, "Idle">>())
export const initialTargetKeys = expand(sample<Machine.Machine.InitialTarget<"Busy">>())
export const historyTargetKeys = expand(sample<Machine.Machine.HistoryTarget<any, any>>())
export const choiceTargetKeys = expand(sample<Machine.Machine.ChoiceTargetInstruction>())
export const stateUpdateKeys = expand(sample<Machine.Machine.StateUpdate<any, any>>())
export const combinedTargetKeys = expand(sample<Machine.Machine.CombinedTarget<1, any, any>>())
export const constructionKeys = expand(sample<Machine.Machine.StateConstruction<1>>())

// Functions whose types carry type-level brands can be exported as they are.
export const select = AtomMachine.select
export const can = AtomMachine.can
export const eventTransition = (transition: MachineTest.FiniteTransition) =>
  transition.trigger.type === "event" ? expand(transition) : undefined
