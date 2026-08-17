import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { FastCheck } from "effect/testing"
import { Machine } from "../../src/index.js"
import { MachineTest } from "../../src/testing/index.js"

class Account extends Schema.TaggedClass<Account>("Account")("Account", {
  balance: Schema.Int
}) {}

class Withdraw extends Schema.TaggedClass<Withdraw>("Withdraw")("Withdraw", {
  amount: Schema.Int
}) {}

class Deposit extends Schema.TaggedClass<Deposit>("Deposit")("Deposit", {
  amount: Schema.Int
}) {}

const States = Machine.defineStates({ account: Account })

const makeAccountMachine = (withdraw: (balance: number, amount: number) => number) =>
  Machine.make({
    states: States.states,
    events: Machine.events(Withdraw, Deposit),
    initial: {
      target: (to) => to.account(),
      resolve: ({ target }) => target(new Account({ balance: 10 }))
    }
  }).handle({
    account: {
      on: {
        Withdraw: Machine.transition({
          target: (to) => to.full.account(),
          resolve: ({ event, state, target }) => target(new Account({ balance: withdraw(state.balance, event.amount) }))
        }),
        Deposit: Machine.transition({
          target: (to) => to.full.account(),
          resolve: ({ event, state, target }) => target(new Account({ balance: state.balance + event.amount }))
        })
      }
    }
  })

describe("MachineTest invariants", () => {
  it.effect("finds semantic failures that structural verification cannot detect", () =>
    Effect.gen(function*() {
      const machine = makeAccountMachine((balance, amount) => balance - amount * 2)
      const define = MachineTest.invariants(machine)
      const nonNegative = define.state(
        "balance is never negative",
        ({ snapshot }) => snapshot.value.balance >= 0 || `negative balance: ${snapshot.value.balance}`
      )
      const trace = yield* MachineTest.run(machine, {
        events: [new Withdraw({ amount: 6 }), new Withdraw({ amount: 1 })]
      })

      yield* MachineTest.verify(machine, trace)
      const error = yield* MachineTest.checkInvariants(machine, trace, [nonNegative]).pipe(Effect.flip)

      assert.strictEqual(error.trace, trace)
      assert.deepStrictEqual(error.report.checks, [{
        invariant: "balance is never negative",
        scope: "state",
        status: "failed",
        observations: 3,
        failures: 2
      }])
      assert.deepStrictEqual(error.violations, [
        {
          invariant: "balance is never negative",
          scope: "state",
          kind: "predicate",
          observationIndex: 1,
          eventIndex: 0,
          phase: "event",
          configuration: ["account"],
          event: new Withdraw({ amount: 6 }),
          message: "negative balance: -2"
        },
        {
          invariant: "balance is never negative",
          scope: "state",
          kind: "predicate",
          observationIndex: 2,
          eventIndex: 1,
          phase: "event",
          configuration: ["account"],
          event: new Withdraw({ amount: 1 }),
          message: "negative balance: -4"
        }
      ])
    }))

  it.effect("checks public steps and complete traces with the same evidence", () =>
    Effect.gen(function*() {
      const machine = makeAccountMachine((balance, amount) => balance - amount)
      const define = MachineTest.invariants(machine)
      const exactWithdrawal = define.step(
        "withdrawal removes exactly its amount",
        ({ after, before, event }) =>
          event._tag !== "Withdraw" ||
          after.value.balance === before.value.balance - event.amount ||
          "withdrawal arithmetic changed"
      )
      const preservesEventCount = define.trace(
        "trace retains every input event",
        ({ trace }) => trace.steps.length === trace.scenario.events.length
      )
      const trace = yield* MachineTest.run(machine, {
        events: [new Deposit({ amount: 2 }), new Withdraw({ amount: 5 })]
      })

      const report = yield* MachineTest.checkInvariants(machine, trace, [exactWithdrawal, preservesEventCount])

      assert.deepStrictEqual(report.checks, [
        {
          invariant: "withdrawal removes exactly its amount",
          scope: "step",
          status: "passed",
          observations: 2,
          failures: 0
        },
        {
          invariant: "trace retains every input event",
          scope: "trace",
          status: "passed",
          observations: 1,
          failures: 0
        }
      ])
    }))

  it.effect("distinguishes untested conditions from required observations", () =>
    Effect.gen(function*() {
      const machine = makeAccountMachine((balance, amount) => balance - amount)
      const define = MachineTest.invariants(machine)
      const trace = yield* MachineTest.run(machine, { events: [] })
      const optional = define.state("only after overdraft", () => true, {
        when: ({ snapshot }) => snapshot.value.balance < 0
      })
      const required = define.step("a withdrawal is exercised", () => true, {
        when: ({ event }) => event._tag === "Withdraw",
        require: { minObservations: 1 }
      })

      const optionalReport = yield* MachineTest.checkInvariants(machine, trace, [optional])
      assert.deepStrictEqual(optionalReport.checks, [{
        invariant: "only after overdraft",
        scope: "state",
        status: "untested",
        observations: 0,
        failures: 0
      }])

      const error = yield* MachineTest.checkInvariants(machine, trace, [required]).pipe(Effect.flip)
      assert.deepStrictEqual(error.report.checks, [{
        invariant: "a withdrawal is exercised",
        scope: "step",
        status: "insufficient",
        observations: 0,
        failures: 0
      }])
      assert.strictEqual(error.violations[0]?.kind, "observations")
      assert.match(error.violations[0]?.message ?? "", /required at least 1 observation but observed 0/)
    }))

  it.effect("can target internal microsteps without duplicating settled observations", () =>
    Effect.gen(function*() {
      const machine = makeAccountMachine((balance, amount) => balance - amount)
      const define = MachineTest.invariants(machine)
      const phases: Array<MachineTest.StateObservation> = []
      const microsteps = define.state(
        "microstep balance remains finite",
        ({ phase, snapshot }) => {
          phases.push(phase)
          return Number.isFinite(snapshot.value.balance)
        },
        { observe: "microsteps" }
      )
      const trace = yield* MachineTest.run(machine, {
        events: [new Deposit({ amount: 1 })]
      })

      const report = yield* MachineTest.checkInvariants(machine, trace, [microsteps])

      assert.deepStrictEqual(phases, ["microstep"])
      assert.strictEqual(report.checks[0]?.observations, 1)
    }))

  const safeMachine = makeAccountMachine((balance, amount) => balance - amount)
  const safe = MachineTest.invariants(safeMachine).state(
    "non-negative generated balances",
    ({ snapshot }) => snapshot.value.balance >= 0
  )
  const safeScenarios = MachineTest.scenarios(safeMachine, {
    eventsArbitrary: FastCheck.array(
      FastCheck.integer({ min: 0, max: 5 }).map((amount) => new Deposit({ amount }))
    )
  })

  it.effect.prop(
    "rechecks invariants after every FastCheck shrink",
    { scenario: safeScenarios.arbitrary },
    ({ scenario }) =>
      MachineTest.run(safeMachine, scenario).pipe(
        Effect.flatMap((trace) => MachineTest.assertInvariants(safeMachine, trace, [safe]))
      ),
    { fastCheck: { numRuns: 25 } }
  )

  it("validates invariant metadata eagerly", () => {
    const define = MachineTest.invariants(safeMachine)
    assert.throws(() => define.trace("", () => true), /name to be a non-empty string/)
    assert.throws(
      () => define.trace("invalid observations", () => true, { require: { minObservations: -1 } }),
      /minObservations to be a non-negative safe integer/
    )
  })
})
