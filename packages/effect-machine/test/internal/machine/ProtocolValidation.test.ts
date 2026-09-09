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
        const events = Machine.eventsFromSchemas(Set)
        let retained: unknown
        const root1 = Machine.state({ states: { Ready: Schema.TaggedStruct("Ready", {}) } })
        const machine = Machine.make({
          root: root1,
          events
        }).handle({
          initial: {
            target: Machine.targets(root1).root.Ready,
            decoded: true,
            data: { _tag: "Ready" }
          },
          states: {
            Ready: {
              on: {
                Set: {
                  none: true,
                  resolve: ({ event }) => {
                    retained = event
                  }
                }
              }
            }
          }
        })
        const initial = yield* Machine.planInitial(machine)
        const selected = ExecutionPlan.selectExecutionPlanForTesting(machine, strategy)
        assert.strictEqual(selected.strategy, strategy === "auto" ? "indexed-flat" : "generic")
        const state = selected.plan.fromConfiguration(
          Configuration.normalizeConfigurationSync<Machine.Machine.States<typeof machine>>(machine, initial.state)
        )
        selected.plan.plan(state, events.Set({ value: 1 }), true)
        Object.assign(retained as object, { value: "invalid" })
        assert.throws(() => selected.plan.plan(state, retained, true), Machine.MachineSchemaDecodeError)
      }))
  }
})
