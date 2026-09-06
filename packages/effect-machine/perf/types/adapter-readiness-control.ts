import { Schema } from "effect"
import { Machine } from "../../dist/index.js"

export const Flow = Schema.TaggedStruct("Flow", {})
export const Idle = Schema.TaggedStruct("Idle", {})
export const Ready = Schema.TaggedStruct("Ready", {})

export const States = Machine.state({
  initial: "Ready",
  states: {
    Flow: {
      schema: Flow,
      initial: "Idle",
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

export const machine = Machine.make({
  id: "perf-readiness",
  root: States,
  events: Machine.eventsFromSchemas(),
  initialConfiguration: (root) => root.resolve(({ target }) => target.from((to) => to.Ready.from(Ready.make({}))))
}).handle({
  states: {
    Flow: {
      history: {
        recent: {
          default: ({ target }) =>
            target.from((tree) => tree.Flow.from(Flow.make({}), (flow) => flow.Idle.from(Idle.make({}))))
        }
      },
      states: {
        Idle: {},
        Route: {
          choice: (to) => to.branch.Ready().resolve(({ target }) => target.from(Ready.make({})))
        }
      }
    },
    Ready: {}
  }
})
