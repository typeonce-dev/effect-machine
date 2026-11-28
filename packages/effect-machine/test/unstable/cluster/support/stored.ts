/**
 * A machine whose checkpoints a deployment before this one stored, and which
 * this one continues.
 */
import { Effect, Schema } from "effect"
import { Machine } from "../../../../src/index.js"

const counter = Machine.make({
  id: "Counter",
  root: Machine.state({
    states: { Counting: { fields: { count: Schema.Number } }, Done: { type: "final", output: Schema.String } }
  }),
  events: Machine.events({ Add: { by: Schema.Number }, Finish: {} })
}).handle({
  initial: { target: "Counting", data: { count: 0 } },
  states: {
    Counting: {
      on: {
        Add: { update: { Counting: ({ event, state }) => ({ count: state.count + event.by }) } },
        Finish: { target: "Done" }
      }
    },
    Done: { output: () => "counted" }
  }
})

export const Counter = Machine.child("counter", counter)

/** Makes the machine, and counts the runs of its effect. */
export const makeStored = () => {
  const loads: Array<unknown> = []
  const machine = Machine.make({
    id: "Stored",
    root: Machine.state({
      states: {
        Idle: {},
        Waiting: {},
        Expired: {},
        Loading: {},
        Loaded: {},
        Hosting: {},
        Ready: { fields: { result: Schema.String } },
        Breaking: {}
      }
    }),
    events: Machine.events({
      Wait: {},
      Load: {},
      Host: {},
      Break: {},
      Note: {},
      Add: { by: Schema.Number },
      Finish: {}
    }),
    effects: {
      load: (event: unknown) =>
        Effect.sync(() => {
          loads.push(event)
          return "document"
        }),
      break: Effect.die(new Error("broken"))
    },
    timers: { wait: "10 seconds" },
    children: { counter: Counter }
  }).handle({
    initial: { target: "Idle" },
    states: {
      Idle: {
        on: {
          Wait: { target: "Waiting" },
          Load: { target: "Loading" },
          Host: { target: "Hosting" },
          Break: { target: "Breaking" }
        }
      },
      Waiting: { invoke: { src: "wait", onDone: { target: "Expired" } } },
      Expired: {},
      Loading: {
        invoke: { src: "load", input: ({ event }) => event, onDone: { stay: true } },
        on: { Note: { target: "Loaded" } }
      },
      Loaded: {},
      Hosting: {
        invoke: { src: "counter", onDone: { target: "Ready", data: ({ output }) => ({ result: output }) } },
        on: {
          Add: { stay: true, commands: ({ event }, enqueue) => enqueue.sendTo(Counter, event) },
          Finish: { stay: true, commands: (_, enqueue) => enqueue.sendTo(Counter, { _tag: "Finish" }) }
        }
      },
      Ready: {},
      Breaking: { invoke: { src: "break" } }
    }
  })
  return { machine, loads }
}
