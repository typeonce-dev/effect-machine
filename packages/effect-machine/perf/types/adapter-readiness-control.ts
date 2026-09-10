import { Schema } from "effect"
import { Machine } from "../../dist/index.js"
export const Flow = Schema.TaggedStruct("Flow", {})
export const Idle = Schema.TaggedStruct("Idle", {})
export const Ready = Schema.TaggedStruct("Ready", {})
export const States = Machine.state({
  states: {
    Flow: {
      schema: Flow,
      states: {
        Idle,
        Route: {
          type: "choice"
        },
        recent: {
          type: "history",
          history: "deep"
        }
      }
    },
    Ready
  }
})
export const snapshot = {
  path: "" as const,
  value: undefined,
  state: { path: "Ready" as const, value: Ready.make({}) }
}
const targets1 = Machine.targets(States)
export const machine = Machine.make({
  id: "perf-readiness",
  root: States,
  events: Machine.eventsFromSchemas()
}).handle({
  initial: {
    target: Machine.targets(States).root.Ready,
    data: Ready.make({})
  },
  states: {
    Flow: {
      initial: {
        target: Machine.targets(States).root.Flow.Idle
      },
      history: {
        recent: {
          default: ({ target }) =>
            target({ states: { Flow: { data: Flow.make({}), states: { Idle: { data: Idle.make({}) } } } } })
        }
      },
      states: {
        Idle: {},
        Route: {
          choice: { target: targets1.root.Ready, data: () => (Ready.make({})) }
        }
      }
    },
    Ready: {}
  }
})
