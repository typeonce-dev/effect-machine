import { assert, describe, it } from "@effect/vitest"
import { Data, type Duration, Effect, Exit, Option, Schema, Stream } from "effect"
import { Machine } from "../../src/index.js"
import { MachineTest } from "../../src/testing/index.js"

class LoadError extends Data.TaggedError("LoadError")<{}> {}

const laws = (report: MachineTest.CheckReport) => report.findings.map((finding) => finding.law)

const LoadStates = Machine.state({
  states: { Idle: {}, Loading: {}, Ready: { fields: { text: Schema.String } }, Failed: {} }
})
const LoadEvents = Machine.events({ Load: {}, Reset: {} })

const loadDocument: Effect.Effect<string, LoadError> = Effect.succeed("# Title")

const LoadMachine = Machine.make({
  id: "Load",
  root: LoadStates,
  events: LoadEvents,
  effects: { loadDocument }
}).handle({
  initial: { target: "Idle" },
  states: {
    Idle: { on: { Load: { target: "Loading" } } },
    Loading: {
      invoke: {
        src: "loadDocument",
        onDone: { target: "Ready", data: ({ output }) => ({ text: output }) },
        onFailure: { target: "Failed" }
      }
    },
    Ready: { on: { Reset: { target: "Idle" } } },
    Failed: { on: { Reset: { target: "Idle" } } }
  }
})

const outcomes = { loadDocument: { done: ["# Title"], failure: [new LoadError()] } }

describe("MachineTest.check outcomes", () => {
  it.effect("does not explore the results of an Effect without outcomes", () =>
    Effect.gen(function*() {
      const report = yield* MachineTest.check(LoadMachine)

      assert.isTrue(report.ok)
      assert.deepStrictEqual(report.limits, ["effectsWithoutOutcomes"])
      // Idle and Loading only.
      assert.strictEqual(report.stats.states, 2)
      assert.deepStrictEqual(laws(report), [])
    }))

  it.effect("visits the states behind onDone and onFailure with supplied outcomes", () =>
    Effect.gen(function*() {
      const report = yield* MachineTest.check(LoadMachine, { outcomes })

      assert.isTrue(report.ok)
      assert.deepStrictEqual(report.limits, ["customOutcomes"])
      assert.strictEqual(report.exploration, "bounded")
      // Idle, Loading, Ready, and Failed.
      assert.strictEqual(report.stats.states, 4)
      assert.strictEqual(report.stats.branches.hit, report.stats.branches.total)
      assert.deepStrictEqual(laws(report), [])
    }))

  it.effect("finds a bug behind onDone with a replay that reproduces it", () =>
    Effect.gen(function*() {
      const report = yield* MachineTest.check(LoadMachine, {
        outcomes: { loadDocument: { done: ["# Title", ""] } },
        invariants: [
          MachineTest.invariants(LoadMachine).state(
            "a ready document has text",
            ({ snapshot }) =>
              LoadStates.get(snapshot, "Ready").pipe(Option.match({
                onNone: () => true,
                onSome: ({ text }) => text.length > 0 || "empty document"
              }))
          )
        ]
      })

      assert.isFalse(report.ok)
      const finding = report.findings.find((finding) => finding.law === "invariant.violated")
      assert.isDefined(finding)
      if (finding?.law !== "invariant.violated") return
      const [load, done] = finding.replay.events
      assert.strictEqual((load as { readonly _tag: string })._tag, "Load")
      assert.isTrue(MachineTest.isWorkOutcome(done))
      assert.deepInclude(done, { kind: "Done", path: "Loading", id: "loadDocument", output: "" })

      const trace = yield* MachineTest.run(LoadMachine, finding.replay as MachineTest.Scenario<typeof LoadMachine>)
      assert.deepStrictEqual(LoadStates.get(trace.final, "Ready"), Option.some({ _tag: "Ready", text: "" }))
      assert.include(MachineTest.formatCheckReport(report), "done Loading#loadDocument \"\"")
    }))

  it.effect("tries every supplied value as a branch, and warns about a branch none of them took", () =>
    Effect.gen(function*() {
      const Branching = Machine.make({
        root: Machine.state({ states: { Loading: {}, Small: {}, Large: {}, Empty: {} } }),
        events: Machine.events({}),
        effects: { count: Effect.succeed(1) }
      }).handle({
        initial: { target: "Loading" },
        states: {
          Loading: {
            invoke: {
              src: "count",
              onDone: {
                branches: [{ target: "Small" }, { target: "Large" }, { target: "Empty" }],
                resolve: ({ output, select }) =>
                  output === 0 ? select.target("Empty") : output < 10 ? select.target("Small") : select.target("Large")
              }
            }
          }
        }
      })

      const report = yield* MachineTest.check(Branching, { outcomes: { count: { done: [1, 100] } } })

      assert.isTrue(report.ok)
      assert.strictEqual(report.stats.states, 3)
      assert.deepStrictEqual(laws(report), ["transition.notCovered"])
      const warning = report.findings[0]!
      assert.isTrue(warning.law === "transition.notCovered" && warning.target === "Empty")
      assert.include(warning.message, "onDone")

      const unsupplied = yield* MachineTest.check(Branching)
      assert.deepStrictEqual(laws(unsupplied), [])
    }))

  it.effect("offers a result once per entry, so a state that stays after its work ended terminates", () =>
    Effect.gen(function*() {
      const Staying = Machine.make({
        root: Machine.state({ states: { Loading: { fields: { loads: Schema.Number } } } }),
        events: Machine.events({ Again: {} }),
        effects: { load: Effect.succeed("a") }
      }).handle({
        initial: { target: "Loading", data: () => ({ loads: 0 }) },
        states: {
          Loading: {
            invoke: { src: "load", onDone: { stay: true } },
            on: { Again: { target: "Loading", reenter: true, data: ({ state }) => ({ loads: state.loads + 1 }) } }
          }
        }
      })

      const report = yield* MachineTest.check(Staying, {
        outcomes: { load: { done: ["a"] } },
        limits: { maxDepth: 3 }
      })

      // Each entry runs the work once: its result is taken, and the state then stays without it.
      const replayed = yield* MachineTest.run(Staying, {
        events: [
          { _tag: MachineTest.WorkOutcomeTypeId, kind: "Done", path: "Loading", id: "load", output: "a" },
          { _tag: MachineTest.WorkOutcomeTypeId, kind: "Done", path: "Loading", id: "load", output: "a" }
        ]
      })
      assert.deepStrictEqual(replayed.work, [])
      assert.strictEqual(replayed.steps[1]!.plan.microsteps.length, 0)
      assert.isTrue(report.ok)
      assert.deepStrictEqual(laws(report), [])
    }))

  it.effect("stops offering the result of a parent's work once it ended", () =>
    Effect.gen(function*() {
      const Events = Machine.events({ Toggle: {} })
      const Parent = Machine.make({
        root: Machine.state({ states: { Busy: { states: { A: {}, B: {} } } } }),
        events: Events,
        effects: { work: Effect.void }
      }).handle({
        initial: { target: "Busy" },
        states: {
          Busy: {
            initial: { target: "Busy.A" },
            invoke: { src: "work", onDone: { target: "Busy.A" } },
            states: { A: { on: { Toggle: { target: "Busy.B" } } }, B: { on: { Toggle: { target: "Busy.A" } } } }
          }
        }
      })

      const report = yield* MachineTest.check(Parent, { outcomes: { work: { done: [undefined] } } })
      // Busy.A and Busy.B, each with the work running and after it ended.
      assert.strictEqual(report.stats.states, 4)
      assert.isTrue(report.ok)
    }))

  it.effect("lets a running timer elapse without any option", () =>
    Effect.gen(function*() {
      const Timeout = Machine.make({
        root: Machine.state({ states: { Waiting: {}, TimedOut: {} } }),
        events: Machine.events({ Retry: {} }),
        timers: { timeout: "1 second" }
      }).handle({
        initial: { target: "Waiting" },
        states: {
          Waiting: { invoke: { src: "timeout", onDone: { target: "TimedOut" } } },
          TimedOut: { on: { Retry: { target: "Waiting" } } }
        }
      })

      const report = yield* MachineTest.check(Timeout)

      assert.isTrue(report.ok)
      assert.strictEqual(report.exploration, "exhaustive")
      assert.deepStrictEqual(report.limits, [])
      assert.strictEqual(report.stats.states, 2)
      assert.strictEqual(report.stats.branches.hit, report.stats.branches.total)
    }))

  it.effect("reproduces a finding behind an elapsed timer from its replay", () =>
    Effect.gen(function*() {
      const Timeout = Machine.make({
        root: Machine.state({ states: { Waiting: {}, TimedOut: {} } }),
        events: Machine.events({ Retry: {} }),
        timers: { timeout: "1 second" }
      }).handle({
        initial: { target: "Waiting" },
        states: {
          Waiting: { invoke: { src: "timeout", onDone: { target: "TimedOut" } } },
          TimedOut: {
            on: {
              Retry: {
                target: "Waiting",
                guard: () => {
                  throw new Error("retry is broken")
                }
              }
            }
          }
        }
      })

      const report = yield* MachineTest.check(Timeout)

      assert.deepStrictEqual(laws(report), ["planning.failed"])
      const finding = report.findings[0]!
      assert.isTrue(finding.law === "planning.failed")
      if (finding.law !== "planning.failed") return
      assert.deepStrictEqual(
        finding.replay.events.map((event) => MachineTest.isWorkOutcome(event) ? event.kind : event),
        ["Elapsed", { _tag: "Retry" }]
      )
      const replayed = yield* Effect.exit(
        MachineTest.run(Timeout, finding.replay as MachineTest.Scenario<typeof Timeout>)
      )
      assert.isTrue(Exit.isFailure(replayed))
      assert.include(MachineTest.formatCheckReport(report), "elapsed Waiting#timeout")
    }))

  it.effect("reports a supplied failure that reaches work with no onFailure", () =>
    Effect.gen(function*() {
      // The compiler requires onFailure for a typed failure, so only an erased
      // source type lets the machine leave it out.
      const erased: Effect.Effect<string> = loadDocument as never
      const Unhandled = Machine.make({
        root: Machine.state({ states: { Loading: {}, Ready: {} } }),
        events: Machine.events({}),
        effects: { loadDocument: erased }
      }).handle({
        initial: { target: "Loading" },
        states: { Loading: { invoke: { src: "loadDocument", onDone: { target: "Ready" } } } }
      })

      const report = yield* MachineTest.check(Unhandled, {
        outcomes: { loadDocument: { done: ["# Title"], failure: [new LoadError()] } } as never
      })

      assert.isFalse(report.ok)
      assert.deepStrictEqual(laws(report), ["outcome.failsMachine"])
      const finding = report.findings[0]!
      assert.isTrue(finding.law === "outcome.failsMachine")
      if (finding.law !== "outcome.failsMachine") return
      assert.strictEqual(finding.source, "loadDocument")
      assert.include(finding.message, "onFailure")

      // The replay fails the machine with the supplied failure.
      const replayed = yield* Effect.flip(
        MachineTest.run(Unhandled, finding.replay as MachineTest.Scenario<typeof Unhandled>)
      )
      assert.instanceOf(replayed.cause, LoadError)
      assert.strictEqual(replayed.phase, "event")
    }))

  it.effect("reports a result whose transition fails to plan as a planning failure", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        root: Machine.state({ states: { Waiting: {}, Ready: { fields: { at: Schema.Number } } } }),
        events: Machine.events({}),
        timers: { wait: "1 second" }
      }).handle({
        initial: { target: "Waiting" },
        states: {
          Waiting: {
            invoke: {
              src: "wait",
              onDone: {
                target: "Ready",
                data: () => {
                  throw new Error("no clock")
                }
              }
            }
          }
        }
      })

      const report = yield* MachineTest.check(machine)

      assert.deepStrictEqual(laws(report), ["planning.failed"])
      const finding = report.findings[0]!
      assert.isTrue(finding.law === "planning.failed")
      if (finding.law !== "planning.failed") return
      assert.include(finding.message, "no clock")
      assert.deepStrictEqual(
        finding.replay.events.map((event) => MachineTest.isWorkOutcome(event) ? event.kind : event),
        ["Elapsed"]
      )
    }))

  it.effect("reports outcomes for a name that no state invokes as an Effect", () =>
    Effect.gen(function*() {
      const report = yield* MachineTest.check(LoadMachine, {
        outcomes: { loadDocument: { done: ["# Title"] }, missing: { done: [1] } } as never
      })

      assert.isFalse(report.ok)
      assert.deepStrictEqual(laws(report), ["outcomes.invalid"])
      const finding = report.findings[0]!
      assert.isTrue(finding.law === "outcomes.invalid" && finding.source === "missing")
      // The valid entry is still explored.
      assert.strictEqual(report.stats.states, 3)
    }))

  it.effect("names Streams, logic, and children it cannot explore as limits", () =>
    Effect.gen(function*() {
      const child = Machine.make({ root: Machine.state({ states: { Idle: {} } }), events: Machine.events({}) })
        .handle({ initial: { target: "Idle" } })
      const machine = Machine.make({
        root: Machine.state({ states: { Working: {} } }),
        events: Machine.events({}),
        streams: { ticks: Stream.make(1, 2) },
        logic: { counter: Machine.logic({ initial: () => Effect.succeed(0), run: () => Effect.never }) },
        children: { worker: Machine.child("worker", child) }
      }).handle({
        initial: { target: "Working" },
        states: {
          Working: {
            invoke: [
              { src: "ticks", onElement: { stay: true }, onDone: { stay: true } },
              { src: "counter", id: "counter", address: Machine.childAddress("counter") },
              { src: "worker" }
            ]
          }
        }
      })

      const report = yield* MachineTest.check(machine)

      assert.deepStrictEqual(report.limits, ["streams", "logic", "children"])
      assert.strictEqual(report.exploration, "bounded")
    }))

  it.effect("never evaluates a source or an input mapper of the work it explores", () =>
    Effect.gen(function*() {
      const evaluated = (name: string): never => {
        throw new Error(`MachineTest evaluated ${name}`)
      }
      const counter = Machine.logic({ initial: () => Effect.succeed(0), run: () => Effect.never })
      const worker = Machine.make({
        root: Machine.state({ states: { Working: {} } }),
        input: Schema.String,
        events: Machine.events({})
      }).handle({ initial: { target: "Working" } })
      const machine = Machine.make({
        root: Machine.state({ states: { Idle: {}, Busy: {}, Loaded: {}, Waited: {} } }),
        events: Machine.events({ Go: {}, Reset: {} }),
        effects: { load: (_: string): Effect.Effect<string> => evaluated("the load source") },
        timers: { wait: (_: number): Duration.Duration => evaluated("the wait duration") },
        streams: { feed: (_: number): Stream.Stream<number> => evaluated("the feed source") },
        logic: { count: (_: number): typeof counter => evaluated("the count logic") },
        children: { worker: Machine.child("worker", worker) }
      }).handle({
        initial: { target: "Idle" },
        states: {
          Idle: { on: { Go: { target: "Busy" } } },
          Busy: {
            invoke: [
              { src: "load", input: () => evaluated("the load input"), onDone: { target: "Loaded" } },
              { src: "wait", input: () => evaluated("the wait input"), onDone: { target: "Waited" } },
              {
                src: "feed",
                input: () => evaluated("the feed input"),
                onElement: { stay: true },
                onDone: { stay: true }
              },
              {
                src: "count",
                id: "count",
                address: Machine.childAddress("count"),
                input: () => evaluated("the count input")
              },
              { src: "worker", input: () => evaluated("the worker input") }
            ]
          },
          Loaded: { on: { Reset: { target: "Idle" } } },
          Waited: { on: { Reset: { target: "Idle" } } }
        }
      })

      const trace = yield* MachineTest.run(machine, { events: [{ _tag: "Go" }] })
      assert.deepStrictEqual(trace.work.map((work) => work.kind), ["Effect", "Timer", "Stream", "Logic", "Child"])

      const report = yield* MachineTest.check(machine, { outcomes: { load: { done: ["text"] } } })
      assert.deepStrictEqual(laws(report), [])
      // Idle, Busy, and the states behind the supplied result and the elapsed timer.
      assert.strictEqual(report.stats.states, 4)
      assert.deepStrictEqual(report.limits, ["customOutcomes", "streams", "logic", "children"])
    }))

  it.effect("tells a state apart from the same state once a transition stopped its logic", () =>
    Effect.gen(function*() {
      const Counter = Machine.childAddress<number>("counter")
      const machine = Machine.make({
        root: Machine.state({ states: { Counting: {} } }),
        events: Machine.events({ Stop: {} }),
        logic: { counter: Machine.logic({ initial: () => Effect.succeed(0), run: () => Effect.never }) }
      }).handle({
        initial: { target: "Counting" },
        states: {
          Counting: {
            invoke: { src: "counter", id: "counter", address: Counter },
            on: { Stop: { stay: true, commands: (_, enqueue) => enqueue.stop(Counter) } }
          }
        }
      })

      const report = yield* MachineTest.check(machine)
      // Counting with the logic running, and after the transition stopped it.
      assert.strictEqual(report.stats.states, 2)
      assert.deepStrictEqual(laws(report), [])
    }))

  it.effect("checks that planning a result is deterministic", () =>
    Effect.gen(function*() {
      const next = () => Math.random()
      const machine = Machine.make({
        root: Machine.state({ states: { Loading: {}, Ready: { fields: { at: Schema.Number } } } }),
        events: Machine.events({}),
        timers: { wait: "1 second" }
      }).handle({
        initial: { target: "Loading" },
        states: { Loading: { invoke: { src: "wait", onDone: { target: "Ready", data: () => ({ at: next() }) } } } }
      })

      const report = yield* MachineTest.check(machine)

      assert.deepStrictEqual(laws(report), ["planning.deterministic"])
      const finding = report.findings[0]!
      assert.isTrue(finding.law === "planning.deterministic" && finding.source === "Loading:Elapsed wait")
    }))

  it.effect("is reproducible for a seed", () =>
    Effect.gen(function*() {
      const first = yield* MachineTest.check(LoadMachine, { outcomes })
      const second = yield* MachineTest.check(LoadMachine, { outcomes })
      assert.strictEqual(MachineTest.formatCheckReport(first), MachineTest.formatCheckReport(second))
    }))
})
