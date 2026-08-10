import { assert, describe, it } from "@effect/vitest"
import { Cause, Clock, Effect, Exit, Option, Schema, Stream } from "effect"
import { FastCheck } from "effect/testing"
import { Machine } from "../../src/index.js"
import { MachineTest } from "../../src/testing/index.js"

class Counter extends Schema.TaggedClass<Counter>("Counter")("Counter", {
  count: Schema.Int
}) {}

class Add extends Schema.TaggedClass<Add>("Add")("Add", {
  amount: Schema.Int
}) {}

class InternalAdd extends Schema.TaggedClass<InternalAdd>("InternalAdd")("InternalAdd", {
  amount: Schema.Int
}) {}

class Noop extends Schema.TaggedClass<Noop>("RuntimeNoop")("Noop", {}) {}
class Ignored extends Schema.TaggedClass<Ignored>("RuntimeIgnored")("Ignored", {}) {}
class Burst extends Schema.TaggedClass<Burst>("RuntimeBurst")("Burst", {}) {}

const CounterStates = Machine.defineStates({ Counter })

const makeCounterMachine = () =>
  Machine.make({
    states: CounterStates.states,
    events: [Add],
    internalEvents: [InternalAdd],
    initial: () => CounterStates.initial.Counter(new Counter({ count: 0 }))
  }).handle({
    Counter: {
      on: {
        Add: ({ event, state, target }) => target.full.Counter(new Counter({ count: state.count + event.amount })),
        InternalAdd: ({ event, state, target }) =>
          target.full.Counter(new Counter({ count: state.count + event.amount }))
      }
    }
  })

const causalMachine = Machine.make({
  states: CounterStates.states,
  events: [Add, Noop, Ignored, Burst],
  internalEvents: [InternalAdd],
  initial: () => CounterStates.initial.Counter(new Counter({ count: 0 }))
}).handle({
  Counter: {
    on: {
      Add: ({ event, state, target }) => target.full.Counter(new Counter({ count: state.count + event.amount })),
      Noop: () => undefined,
      Burst: ({ state, target }, enqueue) => {
        enqueue.raise(new InternalAdd({ amount: 10 }))
        return target.full.Counter(new Counter({ count: state.count + 1 }))
      },
      InternalAdd: ({ event, state, target }) => target.full.Counter(new Counter({ count: state.count + event.amount }))
    }
  }
})

type CounterMachine = ReturnType<typeof makeCounterMachine>
type CounterSnapshot = Machine.Machine.Snapshot<Machine.Machine.States<CounterMachine>>
type CounterRuntimeSnapshot = Machine.RuntimeSnapshot<CounterSnapshot, any, any>

const snapshotCount = (snapshot: CounterRuntimeSnapshot | undefined): number | undefined => snapshot?.state.value.count

const propertyMachine = makeCounterMachine()
const generatedRuntimeCommands = MachineTest.runtimeCommands(propertyMachine, {
  minCommands: 0,
  maxCommands: 20,
  includeCheckpoint: true
})

describe("MachineTest runtime commands", () => {
  it("keeps deprecated ambiguous names as enqueue-oriented compatibility aliases", () => {
    assert.strictEqual(MachineTest.runRuntimeCommands, MachineTest.runEnqueuedCommands)
    assert.strictEqual(MachineTest.formatRuntimeTranscript, MachineTest.formatEnqueuedTranscript)
  })

  it("derives only public send commands and shrinkable clock/lifecycle commands", () => {
    const machine = makeCounterMachine()
    const generated = MachineTest.runtimeCommands(machine, {
      minCommands: 4,
      maxCommands: 4,
      eventArbitrary: FastCheck.constant(new Add({ amount: 1 })),
      advanceArbitrary: FastCheck.constant(10)
    })
    const samples = FastCheck.sample(generated.arbitrary, 20)

    assert.strictEqual(generated.diagnostics.events, "override")
    assert.strictEqual(generated.diagnostics.includesAdvance, true)
    assert.strictEqual(generated.diagnostics.includesStop, true)
    assert.strictEqual(generated.diagnostics.includesCheckpoint, true)
    assert.strictEqual(samples.every((commands) => commands.length === 4), true)
    for (const commands of samples) {
      for (const command of commands) {
        if (command._tag === "Send") assert.instanceOf(command.event, Add)
      }
    }

    const onlySends = MachineTest.runtimeCommands(machine, {
      maxCommands: 10,
      eventArbitrary: FastCheck.constant(new Add({ amount: 1 })),
      includeAdvance: false,
      includeStop: false,
      includeCheckpoint: false
    })
    const shrunk = FastCheck.check(
      FastCheck.property(onlySends.arbitrary, (commands) => commands.length === 0),
      { numRuns: 20 }
    )
    assert.strictEqual(shrunk.failed, true)
    if (shrunk.failed) assert.strictEqual((shrunk.counterexample?.[0] as ReadonlyArray<unknown>).length, 1)
  })

  it.effect.prop(
    "checks schema-generated commands against a pure model after every shrink",
    { commands: generatedRuntimeCommands.arbitrary },
    ({ commands }) =>
      Effect.gen(function*() {
        const ref = yield* Machine.start(propertyMachine)
        const transcript = yield* MachineTest.runEnqueuedCommands(ref, commands, {
          initialModel: { count: 0, stopped: false },
          transition: (model, command) => {
            switch (command._tag) {
              case "Send": {
                const next = model.stopped ? model : { ...model, count: model.count + command.event.amount }
                return Effect.succeed({
                  model: next,
                  expected: {
                    result: model.stopped ? "SendRejected" : "SendAccepted" as string,
                    count: next.count,
                    status: model.stopped ? "stopped" as const : "active" as const
                  },
                  synchronize: model.stopped
                    ? MachineTest.RuntimeSynchronization.none
                    : MachineTest.RuntimeSynchronization.next
                })
              }
              case "Stop":
                return Effect.succeed({
                  model: { ...model, stopped: true },
                  expected: { result: "Stopped" as string, count: model.count, status: "stopped" as const },
                  synchronize: model.stopped
                    ? MachineTest.RuntimeSynchronization.current
                    : MachineTest.RuntimeSynchronization.next
                })
              case "Advance":
                return Effect.succeed({
                  model,
                  expected: {
                    result: "ClockAdvanced" as string,
                    count: model.count,
                    status: model.stopped ? "stopped" as const : "active" as const
                  },
                  synchronize: MachineTest.RuntimeSynchronization.current
                })
              case "Checkpoint":
                return Effect.succeed({
                  model,
                  expected: {
                    result: "Checkpoint" as string,
                    count: model.count,
                    status: model.stopped ? "stopped" as const : "active" as const
                  },
                  synchronize: MachineTest.RuntimeSynchronization.current
                })
            }
          },
          assert: ({ actual, expected }) =>
            Effect.sync(() => {
              assert.strictEqual(actual.result._tag, expected.result)
              if (actual.snapshot !== undefined) {
                assert.strictEqual(actual.snapshot.status, expected.status)
                assert.strictEqual(snapshotCount(actual.snapshot), expected.count)
              }
            })
        })
        assert.strictEqual(transcript.records.length, commands.length)
        yield* ref.stop
      }),
    { fastCheck: { numRuns: 100, seed: 18_241 } }
  )

  it.effect("buffers public changes so a checkpoint can verify multiple queued sends in order", () =>
    Effect.gen(function*() {
      const machine = makeCounterMachine()
      const ref = yield* Machine.start(machine)
      const commands = [
        MachineTest.sendCommand(new Add({ amount: 2 })),
        MachineTest.sendCommand(new Add({ amount: 5 })),
        MachineTest.checkpointCommand("drain queued sends")
      ]
      const transcript = yield* MachineTest.runEnqueuedCommands(ref, commands, {
        initialModel: { count: 0, pending: 0 },
        transition: (model, command) => {
          if (command._tag === "Send") {
            const next = { count: model.count + command.event.amount, pending: model.pending + 1 }
            return Effect.succeed({
              model: next,
              expected: { count: next.count, result: "SendAccepted" as string },
              synchronize: MachineTest.RuntimeSynchronization.none
            })
          }
          const next = { ...model, pending: 0 }
          return Effect.succeed({
            model: next,
            expected: { count: next.count, result: "Checkpoint" as string },
            synchronize: MachineTest.RuntimeSynchronization.until<CounterSnapshot, any>(
              (snapshot) => snapshotCount(snapshot) === next.count
            )
          })
        },
        assert: ({ actual, expected }) =>
          Effect.sync(() => {
            assert.strictEqual(actual.result._tag, expected.result)
            if (actual.snapshot !== undefined) assert.strictEqual(snapshotCount(actual.snapshot), expected.count)
          })
      })

      assert.deepStrictEqual(
        transcript.records[2]?.actual.published.map((snapshot) => snapshotCount(snapshot)),
        [2, 7]
      )
      assert.strictEqual(snapshotCount(transcript.final), 7)
      yield* ref.stop
    }))

  it.effect("advances TestClock deterministically through Machine.after", () =>
    Effect.gen(function*() {
      class Waiting extends Schema.TaggedClass<Waiting>("Waiting")("Waiting", {}) {}
      class TimedOut extends Schema.TaggedClass<TimedOut>("TimedOut")("TimedOut", {}) {}
      class Timeout extends Schema.TaggedClass<Timeout>("Timeout")("Timeout", {}) {}
      const states = Machine.defineStates({ Waiting, TimedOut })
      const machine = Machine.make({
        states: states.states,
        events: [],
        internalEvents: [Timeout],
        initial: () => states.initial.Waiting(new Waiting({}))
      }).handle({
        Waiting: {
          invoke: Machine.after("1 second", new Timeout({})),
          on: { Timeout: ({ target }) => target.full.TimedOut(new TimedOut({})) }
        },
        TimedOut: {}
      })
      const ref = yield* Machine.start(machine)
      const commands = [
        MachineTest.advanceCommand(999),
        MachineTest.checkpointCommand("before timeout"),
        MachineTest.advanceCommand(1),
        MachineTest.checkpointCommand("after timeout")
      ]
      const transcript = yield* MachineTest.runEnqueuedCommands(ref, commands, {
        initialModel: { elapsed: 0, path: "Waiting" as "Waiting" | "TimedOut" },
        transition: (model, command) => {
          if (command._tag === "Advance") {
            const elapsed = model.elapsed + Number(command.duration)
            return Effect.succeed({
              model: { elapsed, path: elapsed >= 1_000 ? "TimedOut" as const : model.path },
              expected: command._tag,
              synchronize: MachineTest.RuntimeSynchronization.none
            })
          }
          return Effect.succeed({
            model,
            expected: model.path,
            synchronize: model.path === "TimedOut"
              ? MachineTest.RuntimeSynchronization.until((snapshot) => snapshot.state.path === "TimedOut")
              : MachineTest.RuntimeSynchronization.current
          })
        },
        assert: ({ actual, command, model }) =>
          Effect.sync(() => {
            if (command._tag === "Checkpoint") {
              assert.strictEqual(actual.snapshot?.state.path, model.path)
            }
          })
      })

      assert.strictEqual(transcript.records[3]?.actual.snapshot?.state.path, "TimedOut")
      yield* ref.stop
    }))

  it.effect("models idempotent stop and rejected sends after stop explicitly", () =>
    Effect.gen(function*() {
      const ref = yield* Machine.start(makeCounterMachine())
      const transcript = yield* MachineTest.runEnqueuedCommands(ref, [
        MachineTest.stopCommand(),
        MachineTest.stopCommand(),
        MachineTest.sendCommand(new Add({ amount: 1 })),
        MachineTest.checkpointCommand("stopped")
      ], {
        initialModel: { stopped: false },
        transition: (model, command) =>
          Effect.succeed({
            model: { stopped: model.stopped || command._tag === "Stop" },
            expected: command._tag === "Send" ? "SendRejected" : command._tag === "Stop" ? "Stopped" : "Checkpoint",
            synchronize: command._tag === "Stop" && !model.stopped
              ? MachineTest.RuntimeSynchronization.next
              : command._tag === "Send"
              ? MachineTest.RuntimeSynchronization.none
              : MachineTest.RuntimeSynchronization.current
          }),
        assert: ({ actual, expected }) =>
          Effect.sync(() => {
            assert.strictEqual(actual.result._tag, expected)
            if (actual.result._tag === "SendRejected") {
              assert.instanceOf(actual.result.error, Machine.StoppedError)
            }
          })
      })

      assert.deepStrictEqual(transcript.records.map(({ actual }) => actual.result._tag), [
        "Stopped",
        "Stopped",
        "SendRejected",
        "Checkpoint"
      ])
      assert.strictEqual(transcript.final.status, "stopped")
    }))

  it.effect("retains a replayable prefix and attempted command in typed failures", () =>
    Effect.gen(function*() {
      const ref = yield* Machine.start(makeCounterMachine())
      const commands = [
        MachineTest.sendCommand(new Add({ amount: 1 })),
        MachineTest.sendCommand(new Add({ amount: 2 }))
      ]
      const failure = yield* MachineTest.runEnqueuedCommands(ref, commands, {
        initialModel: 0,
        transition: (count, command) => {
          const next = count + (command._tag === "Send" ? command.event.amount : 0)
          return Effect.succeed({
            model: next,
            expected: next,
            synchronize: MachineTest.RuntimeSynchronization.next
          })
        },
        assert: ({ expected }) => {
          assert.isBelow(expected, 3, "expected count below three")
          return Effect.void
        }
      }).pipe(Effect.flip)

      assert.strictEqual(failure.phase, "assertion")
      assert.strictEqual(failure.index, 1)
      assert.strictEqual(failure.prefix.length, 1)
      assert.strictEqual(failure.attempted?.index, 1)
      assert.deepStrictEqual(failure.prefix[0]?.command, commands[0])
      assert.deepStrictEqual(failure.command, commands[1])
      assert.strictEqual(Cause.hasDies(failure.cause), true)
      assert.instanceOf(Cause.squash(failure.cause), Error)
      const formatted = MachineTest.formatEnqueuedTranscript(failure)
      assert.match(formatted, /commands:/)
      assert.match(formatted, /command 0:/)
      assert.match(formatted, /failure: phase=assertion index=1/)
      assert.match(formatted, /expected count below three/)
      yield* ref.stop
    }))

  it.effect("fails with structured evidence when an expected publication never arrives", () =>
    Effect.gen(function*() {
      const ref = yield* Machine.start(makeCounterMachine())
      const virtualTimeBefore = yield* Clock.currentTimeMillis
      const failure = yield* MachineTest.runEnqueuedCommands(ref, [
        MachineTest.checkpointCommand("incorrectly expect a publication")
      ], {
        initialModel: undefined,
        observationTimeout: 10,
        transition: (model) =>
          Effect.succeed({
            model,
            expected: undefined,
            synchronize: MachineTest.RuntimeSynchronization.next
          }),
        assert: () => Effect.void
      }).pipe(Effect.flip)

      assert.strictEqual(failure.phase, "observation")
      assert.strictEqual(failure.index, 0)
      assert.strictEqual(failure.prefix.length, 0)
      assert.strictEqual(failure.attempted?.actual.result._tag, "Checkpoint")
      assert.strictEqual(failure.attempted?.actual.snapshot, undefined)
      const cause = Cause.squash(failure.cause)
      assert.instanceOf(cause, MachineTest.RuntimeObservationError)
      assert.strictEqual(cause.reason, "timeout")
      assert.match(cause.message, /timed out after 10ms/)
      assert.strictEqual(yield* Clock.currentTimeMillis, virtualTimeBefore)
      yield* ref.stop
    }))

  it.effect("keeps trailing enqueue-only work explicit instead of sampling a racy final state", () =>
    Effect.gen(function*() {
      const ref = yield* Machine.start(makeCounterMachine())
      const transcript = yield* MachineTest.runEnqueuedCommands(ref, [
        MachineTest.sendCommand(new Add({ amount: 5 })),
        MachineTest.checkpointCommand("racy current sample")
      ], {
        initialModel: 5,
        transition: (model, command) =>
          Effect.succeed({
            model,
            expected: command._tag === "Send" ? "SendAccepted" : "Checkpoint",
            synchronize: command._tag === "Send"
              ? MachineTest.RuntimeSynchronization.none
              : MachineTest.RuntimeSynchronization.current
          }),
        assert: ({ actual, expected }) => Effect.sync(() => assert.strictEqual(actual.result._tag, expected))
      })

      assert.strictEqual(transcript.synchronized, false)
      assert.strictEqual(snapshotCount(transcript.final), 0)
      yield* ref.stop
    }))

  it.effect("does not let one Next observation clear earlier unknown work", () =>
    Effect.gen(function*() {
      const initial = { status: "active" as const, state: 0 }
      const first = { status: "active" as const, state: 1 }
      const second = { status: "active" as const, state: 2 }
      const ref: Machine.MachineRef<number, never> = {
        id: "structural-review-ref",
        sessionId: "structural-review-session",
        state: Effect.succeed(2),
        snapshot: Effect.succeed(second),
        changes: Stream.make(initial, first, second),
        join: Effect.never,
        stop: Effect.void,
        send: () => Effect.void,
        child: () => Effect.succeed(Option.none()),
        childChanges: () => Stream.empty
      }
      const transcript = yield* MachineTest.runEnqueuedCommands(ref, [
        MachineTest.advanceCommand(1),
        MachineTest.checkpointCommand("only consume one")
      ], {
        initialModel: undefined,
        transition: (model, command) =>
          Effect.succeed({
            model,
            expected: undefined,
            synchronize: command._tag === "Advance"
              ? MachineTest.RuntimeSynchronization.none
              : MachineTest.RuntimeSynchronization.next
          }),
        assert: () => Effect.void
      })

      assert.strictEqual(transcript.records[1]?.actual.snapshot?.state, 1)
      assert.strictEqual(transcript.synchronized, false)
    }))

  it.effect("captures command execution defects without losing replay evidence", () =>
    Effect.gen(function*() {
      const ref = yield* Machine.start(makeCounterMachine())
      const invalid = MachineTest.advanceCommand("not a duration" as any)
      const failure = yield* MachineTest.runEnqueuedCommands(ref, [invalid], {
        initialModel: undefined,
        transition: (model) =>
          Effect.succeed({
            model,
            expected: undefined,
            synchronize: MachineTest.RuntimeSynchronization.none
          }),
        assert: () => Effect.void
      }).pipe(Effect.flip)

      assert.strictEqual(failure.phase, "execution")
      assert.strictEqual(failure.index, 0)
      assert.deepStrictEqual(failure.command, invalid)
      assert.strictEqual(failure.prefix.length, 0)
      assert.strictEqual(Cause.hasDies(failure.cause), true)
      yield* ref.stop
    }))

  it.effect("captures synchronous throws while constructing model and inspection effects", () =>
    Effect.gen(function*() {
      const ref = yield* Machine.start(makeCounterMachine())
      const command = MachineTest.checkpointCommand<Add>("synchronous callback")
      const modelFailure = yield* MachineTest.runEnqueuedCommands(ref, [command], {
        initialModel: undefined,
        transition: () => {
          throw new Error("model callback threw")
        },
        assert: () => Effect.void
      }).pipe(Effect.flip)
      assert.strictEqual(modelFailure.phase, "model")
      assert.match(String(Cause.squash(modelFailure.cause)), /model callback threw/)

      const inspectionFailure = yield* MachineTest.runEnqueuedCommands(ref, [command], {
        initialModel: undefined,
        transition: (model) =>
          Effect.succeed({
            model,
            expected: undefined,
            synchronize: MachineTest.RuntimeSynchronization.current
          }),
        inspect: () => {
          throw new Error("inspection callback threw")
        },
        assert: () => Effect.void
      }).pipe(Effect.flip)
      assert.strictEqual(inspectionFailure.phase, "inspection")
      assert.strictEqual(inspectionFailure.attempted?.actual.result._tag, "Checkpoint")
      assert.strictEqual(inspectionFailure.attempted?.actual.snapshot?.status, "active")
      assert.match(String(Cause.squash(inspectionFailure.cause)), /inspection callback threw/)
      yield* ref.stop
    }))

  it.effect("propagates pure interruption instead of reporting a counterexample", () =>
    Effect.gen(function*() {
      const ref = yield* Machine.start(makeCounterMachine())
      const command = MachineTest.checkpointCommand<Add>("interrupt")
      const exit = yield* MachineTest.runEnqueuedCommands(ref, [command], {
        initialModel: undefined,
        transition: (model) =>
          Effect.interrupt.pipe(
            Effect.andThen(Effect.succeed({
              model,
              expected: undefined,
              synchronize: MachineTest.RuntimeSynchronization.current
            }))
          ),
        assert: () => Effect.void
      }).pipe(Effect.exit)

      assert.strictEqual(Exit.isFailure(exit), true)
      if (Exit.isFailure(exit)) assert.strictEqual(Cause.hasInterruptsOnly(exit.cause), true)
      yield* ref.stop
    }))

  it.effect("marks unobserved stop and one-of-possibly-many send publications as outstanding", () =>
    Effect.gen(function*() {
      const stoppedRef = yield* Machine.start(makeCounterMachine())
      const stopped = yield* MachineTest.runEnqueuedCommands(stoppedRef, [MachineTest.stopCommand()], {
        initialModel: undefined,
        transition: (model) =>
          Effect.succeed({
            model,
            expected: undefined,
            synchronize: MachineTest.RuntimeSynchronization.none
          }),
        assert: () => Effect.void
      })
      assert.strictEqual(stopped.final.status, "active")
      assert.strictEqual(stopped.synchronized, false)

      const sentRef = yield* Machine.start(makeCounterMachine())
      const sent = yield* MachineTest.runEnqueuedCommands(sentRef, [
        MachineTest.sendCommand(new Add({ amount: 1 }))
      ], {
        initialModel: undefined,
        transition: (model) =>
          Effect.succeed({
            model,
            expected: undefined,
            synchronize: MachineTest.RuntimeSynchronization.next
          }),
        assert: () => Effect.void
      })
      assert.strictEqual(snapshotCount(sent.final), 1)
      assert.strictEqual(sent.synchronized, false)
      yield* sentRef.stop
    }))
})

describe("MachineTest causal runtime commands", () => {
  it.effect("attributes ignored, targetless, raised, and changing macrosteps to their exact sends", () =>
    Effect.gen(function*() {
      const ref = yield* Machine.start(causalMachine)
      const probe = yield* MachineTest.probe(causalMachine, ref)
      const commands = [
        MachineTest.sendCommand(new Ignored({})),
        MachineTest.sendCommand(new Noop({})),
        MachineTest.sendCommand(new Add({ amount: 2 })),
        MachineTest.sendCommand(new Burst({}))
      ]
      const transcript = yield* MachineTest.runCausalCommands(probe, commands, {
        initialModel: 0,
        transition: (count, command) => {
          const expected = command._tag !== "Send"
            ? count
            : command.event._tag === "Add"
            ? count + command.event.amount
            : command.event._tag === "Burst"
            ? count + 11
            : count
          return Effect.succeed({ model: expected, expected })
        },
        assert: ({ actual, expected }) =>
          Effect.sync(() => {
            assert.strictEqual(actual.snapshot.state.value.count, expected)
            if (actual.result._tag === "SendProcessed") {
              assert.strictEqual(actual.result.step.after.value.count, expected)
            }
          })
      })

      const [ignored, targetless, changed, burst] = transcript.records
      assert.strictEqual(ignored?.actual.result._tag, "SendProcessed")
      if (ignored?.actual.result._tag === "SendProcessed") {
        assert.strictEqual(ignored.actual.result.step.handled, false)
        assert.strictEqual(ignored.actual.result.step.plan.microsteps.length, 0)
      }
      assert.strictEqual(targetless?.actual.result._tag, "SendProcessed")
      if (targetless?.actual.result._tag === "SendProcessed") {
        assert.strictEqual(targetless.actual.result.step.handled, true)
        assert.strictEqual(targetless.actual.result.step.plan.microsteps.length, 1)
      }
      assert.strictEqual(changed?.actual.result._tag, "SendProcessed")
      if (changed?.actual.result._tag === "SendProcessed") {
        assert.strictEqual(changed.actual.result.step.before.value.count, 0)
        assert.strictEqual(changed.actual.result.step.after.value.count, 2)
      }
      assert.strictEqual(burst?.actual.result._tag, "SendProcessed")
      if (burst?.actual.result._tag === "SendProcessed") {
        assert.deepStrictEqual(
          burst.actual.result.step.plan.microsteps.map(({ event }) => event._tag),
          ["Burst", "InternalAdd"]
        )
        assert.strictEqual(burst.actual.result.step.before.value.count, 2)
        assert.strictEqual(burst.actual.result.step.after.value.count, 13)
      }
      assert.strictEqual(transcript.final.state.value.count, 13)
      yield* ref.stop
    }))

  it.effect.prop(
    "checks and shrinks generated command sequences at causal boundaries",
    {
      commands: MachineTest.runtimeCommands(causalMachine, {
        maxCommands: 20,
        eventArbitrary: FastCheck.oneof(
          FastCheck.integer({ min: -10, max: 10 }).map((amount) => new Add({ amount })),
          FastCheck.constant(new Ignored({})),
          FastCheck.constant(new Noop({}))
        ),
        includeAdvance: false,
        includeStop: false,
        includeCheckpoint: false
      }).arbitrary
    },
    ({ commands }) =>
      Effect.gen(function*() {
        const ref = yield* Machine.start(causalMachine)
        const probe = yield* MachineTest.probe(causalMachine, ref)
        const transcript = yield* MachineTest.runCausalCommands(probe, commands, {
          initialModel: 0,
          transition: (count, command) => {
            const next = command._tag === "Send" && command.event._tag === "Add"
              ? count + command.event.amount
              : count
            return Effect.succeed({ model: next, expected: next })
          },
          assert: ({ actual, expected }) =>
            Effect.sync(() => {
              assert.strictEqual(actual.snapshot.state.value.count, expected)
              if (actual.result._tag === "SendProcessed") {
                assert.strictEqual(actual.result.step.after.value.count, expected)
              }
            })
        })
        assert.strictEqual(transcript.finalModel, transcript.final.state.value.count)
        yield* ref.stop
      }),
    { fastCheck: { numRuns: 100, seed: 31_590 } }
  )

  it.effect("represents stopped sends without turning an expected rejection into a failed property", () =>
    Effect.gen(function*() {
      const ref = yield* Machine.start(causalMachine)
      const probe = yield* MachineTest.probe(causalMachine, ref)
      const transcript = yield* MachineTest.runCausalCommands(probe, [
        MachineTest.stopCommand(),
        MachineTest.sendCommand(new Add({ amount: 1 }))
      ], {
        initialModel: false,
        transition: (stopped, command) =>
          Effect.succeed({
            model: stopped || command._tag === "Stop",
            expected: command._tag === "Send" ? "SendRejected" : "Stopped"
          }),
        assert: ({ actual, expected }) => Effect.sync(() => assert.strictEqual(actual.result._tag, expected))
      })

      assert.strictEqual(transcript.records[1]?.actual.result._tag, "SendRejected")
      if (transcript.records[1]?.actual.result._tag === "SendRejected") {
        assert.instanceOf(transcript.records[1].actual.result.error, Machine.StoppedError)
      }
      assert.strictEqual(transcript.final.status, "stopped")
    }))

  it.effect("uses RuntimeAwait only for asynchronous work after the causal command boundary", () =>
    Effect.gen(function*() {
      class Waiting extends Schema.TaggedClass<Waiting>("CausalWaiting")("Waiting", {}) {}
      class TimedOut extends Schema.TaggedClass<TimedOut>("CausalTimedOut")("TimedOut", {}) {}
      class Timeout extends Schema.TaggedClass<Timeout>("CausalTimeout")("Timeout", {}) {}
      const states = Machine.defineStates({ Waiting, TimedOut })
      const timerMachine = Machine.make({
        states: states.states,
        events: [],
        internalEvents: [Timeout],
        initial: () => states.initial.Waiting(new Waiting({}))
      }).handle({
        Waiting: {
          invoke: Machine.after("1 second", new Timeout({})),
          on: { Timeout: ({ target }) => target.full.TimedOut(new TimedOut({})) }
        },
        TimedOut: {}
      })
      const ref = yield* Machine.start(timerMachine)
      const probe = yield* MachineTest.probe(timerMachine, ref)
      const transcript = yield* MachineTest.runCausalCommands(probe, [MachineTest.advanceCommand(1_000)], {
        initialModel: "Waiting" as "Waiting" | "TimedOut",
        transition: () =>
          Effect.succeed({
            model: "TimedOut" as const,
            expected: "TimedOut" as const,
            await: probe.await.until((snapshot) => snapshot.state.path === "TimedOut")
          }),
        assert: ({ actual, expected }) =>
          Effect.sync(() => {
            assert.strictEqual(actual.snapshot.state.path, expected)
            assert.isAtLeast(actual.awaited.length, 1)
          })
      })

      assert.strictEqual(transcript.final.state.path, "TimedOut")
      yield* ref.stop
    }))

  it.effect("attributes processing failures to the exact causal command and prefix", () =>
    Effect.gen(function*() {
      const ref = yield* Machine.start(causalMachine)
      const probe = yield* MachineTest.probe(causalMachine, ref)
      const commands = [
        MachineTest.sendCommand(new Add({ amount: 1 })),
        MachineTest.sendCommand({ _tag: "Add", amount: "invalid" } as unknown as Add)
      ]
      const failure = yield* MachineTest.runCausalCommands(probe, commands, {
        initialModel: 0,
        transition: (count, command) =>
          Effect.succeed({
            model: count + (command._tag === "Send" && command.event._tag === "Add" &&
                typeof command.event.amount === "number"
              ? command.event.amount
              : 0),
            expected: undefined
          }),
        assert: () => Effect.void
      }).pipe(Effect.flip)

      assert.strictEqual(failure.phase, "execution")
      assert.strictEqual(failure.index, 1)
      assert.strictEqual(failure.prefix.length, 1)
      assert.deepStrictEqual(failure.command, commands[1])
      assert.deepStrictEqual(failure.attempted?.command, commands[1])
      assert.strictEqual(failure.attempted?.result, undefined)
      assert.instanceOf(Cause.squash(failure.cause), Machine.MachineSchemaDecodeError)
      const formatted = MachineTest.formatCausalTranscript(failure)
      assert.match(formatted, /command 0:/)
      assert.match(formatted, /attempted 1:/)
      assert.match(formatted, /failure: phase=execution index=1/)
      const snapshot = yield* ref.snapshot
      assert.strictEqual(snapshot.status, "error")
    }))

  it.effect("does not confuse a processing StoppedError with mailbox rejection", () =>
    Effect.gen(function*() {
      const ref = yield* Machine.start(causalMachine)
      const attached = yield* MachineTest.probe(causalMachine, ref)
      const stopped = new Machine.StoppedError()
      const snapshot = yield* ref.snapshot
      const failedRef: typeof ref = {
        ...ref,
        snapshot: Effect.succeed({ status: "error", state: snapshot.state, cause: Cause.fail(stopped) })
      }
      const failingProbe: typeof attached = {
        ...attached,
        ref: failedRef,
        sendAndAwait: () => Effect.fail(stopped)
      }
      const failure = yield* MachineTest.runCausalCommands(failingProbe, [
        MachineTest.sendCommand(new Add({ amount: 1 }))
      ], {
        initialModel: undefined,
        transition: (model) => Effect.succeed({ model, expected: undefined }),
        assert: () => Effect.void
      }).pipe(Effect.flip)

      assert.strictEqual(failure.phase, "execution")
      assert.instanceOf(Cause.squash(failure.cause), Machine.StoppedError)
      yield* ref.stop
    }))
})
