/**
 * @title Creating and running a machine
 *
 * Declare the topology, the protocol, and the behavior, then start the result
 * inside a Scope.
 */
import { Machine } from "@typeonce/effect-machine"
import { Effect, Schema } from "effect"

// The root declares the topology and the data each state owns.
export const CounterStates = Machine.state({
  states: {
    Idle: {},
    Running: { fields: { count: Schema.Number } }
  }
})

// Events are the public protocol. Each one also becomes a typed constructor.
export const CounterEvents = Machine.events({ Start: {}, Increment: {}, Stop: {} })

// `make` joins the topology and protocol. `handle` implements every state and
// returns the machine to export.
export const CounterMachine = Machine.make({
  id: "Counter",
  root: CounterStates,
  events: CounterEvents
}).handle({
  initial: { target: "Idle" },
  states: {
    Idle: {
      on: {
        Start: { target: "Running", data: () => ({ count: 0 }) }
      }
    },
    Running: {
      on: {
        Increment: { update: { Running: ({ state }) => ({ count: state.count + 1 }) } },
        Stop: { target: "Idle" }
      }
    }
  }
})

// `Machine.start` requires a Scope. Closing it stops the machine and everything
// the machine owns.
export const program = Effect.scoped(Effect.gen(function*() {
  const counter = yield* Machine.start(CounterMachine)

  yield* counter.send(CounterEvents.Start())
  yield* counter.send(CounterEvents.Increment())
}))
