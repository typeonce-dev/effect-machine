/**
 * @title Verifying a machine after changing it
 *
 * Run `MachineTest.check` after every change. It needs no test setup, and a
 * finding names the law it broke and the events that reproduce it.
 */
import { Machine } from "@typeonce/effect-machine"
import { MachineTest } from "@typeonce/effect-machine/testing"
import { Effect } from "effect"

export const SwitchMachine = Machine.make({
  root: Machine.state({ states: { Off: {}, On: {} } }),
  events: Machine.events({ Toggle: {} })
}).handle({
  initial: { target: "Off" },
  states: {
    Off: { on: { Toggle: { target: "On" } } },
    On: { on: { Toggle: { target: "Off" } } }
  }
})

export const verified = Effect.gen(function*() {
  const report = yield* MachineTest.check(SwitchMachine)
  if (!report.ok) {
    return yield* Effect.die(MachineTest.formatCheckReport(report))
  }
  // "exhaustive" means nothing limited exploration. "bounded" lists why in `limits`, and is not a proof.
  return report.exploration
})
