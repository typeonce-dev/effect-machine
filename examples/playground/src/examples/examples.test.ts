import { assert, describe, it } from "@effect/vitest"
import { Machine } from "@typeonce/effect-machine"
import { MachineTest } from "@typeonce/effect-machine/testing"
import { Effect } from "effect"
import { MicrowaveEvent, MicrowaveMachine } from "./microwave/machine.ts"
import { TrafficLightMachine } from "./traffic-light/machine.ts"
import { TurnstileEvent, TurnstileMachine } from "./turnstile/machine.ts"
import { SharedMachine, SharedMachineEvent } from "./worker-tabs/machine.ts"

describe("playground machines", () => {
  it.effect("accepts only the command enabled by the current turnstile state", () =>
    Effect.gen(function*() {
      const trace = yield* MachineTest.run(TurnstileMachine, {
        events: [
          TurnstileEvent.cases.GatePushed.make({}),
          TurnstileEvent.cases.CoinInserted.make({}),
          TurnstileEvent.cases.CoinInserted.make({}),
          TurnstileEvent.cases.GatePushed.make({})
        ]
      })

      yield* MachineTest.verify(TurnstileMachine, trace)
      assert.deepStrictEqual(trace.steps.map(({ plan }) => plan.microsteps.length > 0), [false, true, false, true])
      assert.strictEqual(trace.final.path, "Locked")
    }))

  it.effect("advances state-scoped traffic-light timers with the runtime clock", () =>
    Effect.gen(function*() {
      const ref = yield* Machine.start(TrafficLightMachine)
      const probe = yield* MachineTest.probe(TrafficLightMachine, ref)
      const transcript = yield* MachineTest.verifyCausalCommands(
        probe,
        [MachineTest.advanceCommand(4_000), MachineTest.advanceCommand(1_000)],
        {
          invariants: [],
          await: ({ index }) =>
            probe.await.until((snapshot) => snapshot.state.path === (index === 0 ? "RedYellow" : "Green"))
        }
      )

      assert.strictEqual(transcript.final.state.path, "Green")
      yield* ref.stop
    }))

  it.effect("interrupts cooking and opens the door in one parallel macrostep", () =>
    Effect.gen(function*() {
      const trace = yield* MachineTest.run(MicrowaveMachine, {
        events: [
          MicrowaveEvent.cases.PowerPressed.make({}),
          MicrowaveEvent.cases.DoorOpened.make({}),
          MicrowaveEvent.cases.PowerPressed.make({}),
          MicrowaveEvent.cases.DoorClosed.make({}),
          MicrowaveEvent.cases.PowerPressed.make({})
        ]
      })

      yield* MachineTest.verify(MicrowaveMachine, trace)
      const opened = trace.steps[1]?.after
      assert.strictEqual(opened?.states.engine.state.path, "Oven.engine.Idle")
      assert.strictEqual(opened?.states.door.state.path, "Oven.door.Open")
      assert.deepStrictEqual(trace.steps[2]?.before, trace.steps[2]?.after)
      assert.strictEqual(trace.final.states.engine.state.path, "Oven.engine.Cooking")
      assert.strictEqual(trace.final.states.door.state.path, "Oven.door.Closed")
    }))

  it.effect("restores worker state from a tab synchronization command", () =>
    Effect.gen(function*() {
      const trace = yield* MachineTest.run(SharedMachine, {
        events: [
          SharedMachineEvent.cases.Started.make({}),
          SharedMachineEvent.cases.Incremented.make({}),
          SharedMachineEvent.cases.Synchronized.make({ active: false, count: 12 })
        ]
      })

      yield* MachineTest.verify(SharedMachine, trace)
      assert.strictEqual(trace.final.path, "Idle")
      assert.strictEqual(trace.final.value.count, 12)
    }))
})
