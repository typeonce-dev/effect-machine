import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Machine } from "../../../src/index.js"
import * as Configuration from "../../../src/internal/machine/configuration.js"
import * as ExecutionPlan from "../../../src/internal/machine/executionPlan.js"

describe("event validation across execution strategies", () => {
  for (const strategy of ["generic", "auto"] as const) {
    it.effect(`rejects mutated decoded events in the ${strategy} planner`, () =>
      Effect.gen(function*() {
        const Set = Schema.TaggedStruct("Set", { value: Schema.Int })
        const events = Machine.events(Set)
        let retained: unknown
        const machine = Machine.make({
          states: { Ready: Schema.TaggedStruct("Ready", {}) },
          events,
          initial: (to) => to.Ready().resolve(({ target }) => target.decoded({ _tag: "Ready" }))
        }).handle({
          Ready: {
            on: {
              Set: (to) =>
                to.none.resolve(({ event }) => {
                  retained = event
                })
            }
          }
        })
        const initial = yield* Machine.planInitial(machine)
        const selected = ExecutionPlan.selectExecutionPlanForTesting(machine, strategy)
        assert.strictEqual(selected.strategy, strategy === "auto" ? "indexed-flat" : "generic")
        const state = selected.plan.fromConfiguration(Configuration.normalizeConfigurationSync(machine, initial.state))
        selected.plan.plan(state, events.Set({ value: 1 }), true)
        Object.assign(retained as object, { value: "invalid" })
        assert.throws(() => selected.plan.plan(state, retained, true), Machine.MachineSchemaDecodeError)
      }))
  }
})
