/**
 * @title Choosing a destination from an event
 *
 * List every destination in `branches`, next to the `resolve` that selects one.
 * The compiler checks one against the other, so this transition can be edited
 * without reading anything else.
 */
import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

export const CheckoutStates = Machine.state({
  fields: { attempts: Schema.Number },
  states: {
    Editing: {},
    Charging: { fields: { amount: Schema.Number } },
    Paid: {}
  }
})

export const CheckoutEvents = Machine.events({
  Pay: { amount: Schema.Number },
  Paid: {}
})

export const CheckoutMachine = Machine.make({
  root: CheckoutStates,
  events: CheckoutEvents
}).handle({
  root: { attempts: 0 },
  initial: { target: "Editing" },
  states: {
    Editing: {
      on: {
        Pay: {
          // `stay` accepts the event, so `Machine.can` is true. `decline` refuses it, so `Machine.can` is false and a
          // parent handler for the same event runs.
          branches: [{ target: "Charging" }, { target: "Paid" }, { update: "root" }, { stay: true }, { decline: true }],
          resolve: ({ event, root, select }) => {
            if (event.amount < 0) return select.decline()
            if (event.amount === 0) return select.target("Paid")
            if (root.attempts >= 3) return select.stay()
            if (event.amount > 1_000) return select.update({ root: { attempts: root.attempts + 1 } })
            // Each call takes the values of the path it is given.
            return select.target("Charging", { data: { amount: event.amount } })
          }
        }
      }
    },
    Charging: {
      on: {
        Paid: { target: "Paid" }
      }
    }
  }
})
