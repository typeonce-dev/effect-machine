import { assert, describe, it } from "@effect/vitest"
import { Cause, Duration, Effect, Exit, Schema, Stream } from "effect"
import { Machine } from "../../src/index.js"

/** The parts of a step that are data, without the work a source built. */
const dataOf = (step: Machine.MachineStep.Step<any>) => ({
  snapshot: step.snapshot,
  emitted: step.emitted,
  sends: step.sends,
  stop: step.stop.map(keyOf),
  start: step.start.map(keyOf),
  exit: step.exit
})

const keyOf = ({ _tag, id, path, run }: Machine.MachineStep.Work<any>) => ({ _tag, path, id, run })

const success = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) throw new Error(`Expected a success, received ${Cause.pretty(exit.cause)}`)
  return exit.value
}

const only = <W>(work: ReadonlyArray<W>): W => {
  assert.strictEqual(work.length, 1)
  return work[0]!
}

// Every machine of these tests has a root with states.
const leafOf = (step: Machine.MachineStep.Step<any>): string =>
  (step.snapshot as unknown as { readonly state: { readonly path: string } }).state.path

const self: Machine.MachineTarget<any> = { id: "loader", sessionId: "loader:test", send: () => Effect.void }

const Events = Machine.events({ Load: { id: Schema.NonEmptyString }, Cancel: {}, Wait: {}, Ask: {}, Answer: {} })
const Emitted = Machine.emittedEvents({ Loaded: { id: Schema.String } })

const loader = Machine.make({
  id: "loader",
  root: Machine.state({
    states: {
      Idle: {},
      Loading: { fields: { id: Schema.String } },
      Waiting: {},
      Asked: {},
      Loaded: { fields: { result: Schema.String } },
      Failed: { fields: { reason: Schema.String } },
      TimedOut: {}
    }
  }),
  events: Events,
  emittedEvents: Emitted,
  effects: {
    load: (id: string) => id === "missing" ? Effect.fail({ reason: "not found" }) : Effect.succeed(`document ${id}`)
  },
  timers: { wait: (seconds: number) => Duration.seconds(seconds) }
}).handle({
  initial: { target: "Idle" },
  states: {
    Idle: {
      on: {
        Load: { target: "Loading", data: ({ event }) => ({ id: event.id }) },
        Wait: { target: "Waiting" },
        Ask: { target: "Asked", commands: ({ self }, enqueue) => enqueue.sendTo(self, { _tag: "Answer" }) }
      }
    },
    Loading: {
      invoke: {
        src: "load",
        input: ({ state }) => {
          if (state.id === "throws") throw new Error("no input")
          return state.id
        },
        onDone: {
          target: "Loaded",
          data: ({ output }) => ({ result: output }),
          commands: ({ state }, enqueue) => enqueue.emit({ _tag: "Loaded", id: state.id })
        },
        onFailure: { target: "Failed", data: ({ error }) => ({ reason: error.reason }) }
      },
      on: { Cancel: { target: "Idle" } }
    },
    Waiting: {
      invoke: { src: "wait", input: () => 90, onDone: { target: "TimedOut" } },
      on: { Cancel: { target: "Idle" } }
    },
    Asked: { on: { Answer: { target: "Idle" } } },
    Loaded: {},
    Failed: {},
    TimedOut: {}
  }
})

const step = Machine.toStep(loader, { self })

describe("Machine.toStep", () => {
  it.effect("runs an effect and routes its output through onDone", () =>
    Effect.gen(function*() {
      const started = success(step.start())
      assert.strictEqual(leafOf(started), "Idle")
      assert.deepStrictEqual(started.start, [])

      const loading = success(step.send(started.state, Events.Load({ id: "a" })))
      assert.strictEqual(leafOf(loading), "Loading")
      const work = only(loading.start)
      assert.deepStrictEqual(keyOf(work), { _tag: "Effect", path: "Loading", id: "load", run: 0 })
      assert.strictEqual(work.source, "load")
      if (work._tag !== "Effect") throw new Error(`Unexpected ${work._tag}`)

      const loaded = step.settle(loading.state, work, yield* Effect.exit(work.effect))
      assert.deepStrictEqual(loaded.snapshot.state.value, { _tag: "Loaded", result: "document a" })
      assert.deepStrictEqual(loaded.emitted, [{ _tag: "Loaded", id: "a" }])
      assert.deepStrictEqual(loaded.stop, [])
      assert.strictEqual(loaded.exit, undefined)

      // The work ended, so its end applies once.
      assert.deepStrictEqual(step.settle(loaded.state, work, Exit.succeed("again")).state, loaded.state)
    }))

  it.effect("routes a typed failure of work through onFailure", () =>
    Effect.gen(function*() {
      const loading = success(step.send(success(step.start()).state, Events.Load({ id: "missing" })))
      const work = only(loading.start)
      if (work._tag !== "Effect") throw new Error(`Unexpected ${work._tag}`)
      const failed = step.settle(loading.state, work, yield* Effect.exit(work.effect))
      assert.deepStrictEqual(failed.snapshot.state.value, { _tag: "Failed", reason: "not found" })
    }))

  it("describes a timer by its duration, which the host waits for", () => {
    const waiting = success(step.send(success(step.start()).state, Events.Wait()))
    const timer = only(waiting.start)
    if (timer._tag !== "Timer") throw new Error(`Unexpected ${timer._tag}`)
    assert.deepStrictEqual(timer.duration, Duration.seconds(90))
    assert.strictEqual(leafOf(step.settle(waiting.state, timer, Exit.void)), "TimedOut")
  })

  describe("purity", () => {
    it("gives equal results for equal arguments, and changes no value it was given", () => {
      const started = success(step.start())
      const before = structuredClone(started.snapshot)
      const first = success(step.send(started.state, Events.Load({ id: "a" })))
      const second = success(step.send(started.state, Events.Load({ id: "a" })))
      assert.deepStrictEqual(dataOf(first), dataOf(second))
      assert.deepStrictEqual(started.snapshot, before)
      assert.deepStrictEqual(dataOf(success(step.start())), dataOf(started))
    })

    it("steps again from a state that it kept, as a view that travels in time does", () => {
      const started = success(step.start())
      const loading = success(step.send(started.state, Events.Load({ id: "a" })))
      const idle = success(step.send(loading.state, Events.Cancel()))
      const waiting = success(step.send(idle.state, Events.Wait()))
      assert.strictEqual(leafOf(waiting), "Waiting")

      // The kept state still loads, and its work is still current there.
      const work = only(loading.start)
      const again = success(step.send(loading.state, Events.Cancel()))
      assert.deepStrictEqual(dataOf(again), dataOf(idle))
      assert.strictEqual(leafOf(step.settle(loading.state, work, Exit.succeed("document a"))), "Loaded")
      assert.deepStrictEqual(dataOf(step.settle(waiting.state, work, Exit.succeed("document a"))), {
        ...dataOf(waiting),
        emitted: [],
        sends: [],
        stop: [],
        start: []
      })
    })
  })

  describe("stale results", () => {
    it("ignores the end of work whose state was exited", () => {
      const loading = success(step.send(success(step.start()).state, Events.Load({ id: "a" })))
      const work = only(loading.start)
      const idle = success(step.send(loading.state, Events.Cancel()))
      assert.deepStrictEqual(idle.stop.map(keyOf), [keyOf(work)])

      const late = step.settle(idle.state, work, Exit.succeed("document a"))
      assert.strictEqual(late.state, idle.state)
      assert.strictEqual(leafOf(late), "Idle")
      assert.deepStrictEqual([late.emitted, late.sends, late.stop, late.start], [[], [], [], []])
    })

    it("ignores the end of work of an earlier entry of the same state", () => {
      const first = success(step.send(success(step.start()).state, Events.Load({ id: "first" })))
      const idle = success(step.send(first.state, Events.Cancel()))
      const second = success(step.send(idle.state, Events.Load({ id: "second" })))
      const [stale, current] = [only(first.start), only(second.start)]
      assert.deepStrictEqual([stale.path, stale.id, stale.run], [current.path, current.id, 0])
      assert.strictEqual(current.run, 1)

      const late = step.settle(second.state, stale, Exit.succeed("document first"))
      assert.strictEqual(late.state, second.state)
      assert.strictEqual(leafOf(late), "Loading")

      const loaded = step.settle(late.state, current, Exit.succeed("document second"))
      assert.deepStrictEqual(loaded.snapshot.state.value, { _tag: "Loaded", result: "document second" })
    })
  })

  describe("rejection", () => {
    it("rejects an event that its schema refuses, and keeps the machine", () => {
      const started = success(step.start())
      const rejected = step.send(started.state, { _tag: "Load", id: "" })
      assert.isTrue(Exit.isFailure(rejected))
      if (Exit.isSuccess(rejected)) return
      const error = Cause.squash(rejected.cause)
      assert.instanceOf(error, Machine.MachineSchemaDecodeError)

      const loading = success(step.send(started.state, Events.Load({ id: "a" })))
      assert.strictEqual(leafOf(loading), "Loading")
    })

    it("rejects every event once the machine has ended", () => {
      const stopped = step.stop(success(step.send(success(step.start()).state, Events.Load({ id: "a" }))).state)
      const rejected = step.send(stopped.state, Events.Cancel())
      assert.isTrue(Exit.isFailure(rejected) && Cause.squash(rejected.cause) instanceof Machine.StoppedError)
    })
  })

  describe("failures", () => {
    it("fails the machine in the step whose source throws, and starts none of its work", () => {
      const loading = step.send(success(step.start()).state, Events.Load({ id: "throws" }))
      const failed = success(loading)
      assert.strictEqual(leafOf(failed), "Loading")
      assert.deepStrictEqual(failed.start, [])
      const exit = failed.exit
      assert.isTrue(exit !== undefined && Exit.isFailure(exit) && Exit.hasDies(exit))
      if (exit !== undefined && Exit.isFailure(exit)) {
        assert.strictEqual((Cause.squash(exit.cause) as Error).message, "no input")
      }
      assert.deepStrictEqual(step.send(failed.state, Events.Cancel()), Exit.fail(new Machine.StoppedError()))
    })

    it("fails the machine with a defect of its work, and stops the rest", () => {
      const loading = success(step.send(success(step.start()).state, Events.Load({ id: "a" })))
      const failed = step.settle(loading.state, only(loading.start), Exit.die(new Error("broken")))
      assert.isTrue(failed.exit !== undefined && Exit.hasDies(failed.exit))
      assert.strictEqual(leafOf(failed), "Loading")
    })

    it("fails the machine with a transition that throws, in the state before it", () => {
      const throwing = Machine.make({
        root: Machine.state({ states: { Idle: {} } }),
        events: Machine.events({ Throw: {} })
      }).handle({
        initial: { target: "Idle" },
        states: {
          Idle: {
            on: {
              Throw: {
                stay: true,
                commands: () => {
                  throw new Error("transition")
                }
              }
            }
          }
        }
      })
      const steps = Machine.toStep(throwing, { self })
      const started = success(steps.start())
      const failed = success(steps.send(started.state, { _tag: "Throw" }))
      assert.strictEqual(failed.snapshot, started.snapshot)
      assert.isTrue(failed.exit !== undefined && Exit.hasDies(failed.exit))
    })

    it("refuses a command addressed to a child, which this host cannot own", () => {
      const Child = Machine.child(
        "child",
        Machine.make({ root: Machine.state({ states: { Idle: {} } }), events: Machine.events({ Ping: {} }) }).handle({
          initial: { target: "Idle" }
        })
      )
      const addressing = Machine.make({
        root: Machine.state({ states: { Idle: {} } }),
        events: Machine.events({ Ping: {} })
      }).handle({
        initial: { target: "Idle" },
        states: {
          Idle: { on: { Ping: { stay: true, commands: (_, enqueue) => enqueue.sendTo(Child, { _tag: "Ping" }) } } }
        }
      })
      const steps = Machine.toStep(addressing, { self })
      const failed = success(steps.send(success(steps.start()).state, { _tag: "Ping" }))
      assert.isDefined(failed.exit)
      if (failed.exit === undefined || Exit.isSuccess(failed.exit)) return
      assert.instanceOf(Cause.squash(failed.exit.cause), Machine.ProcessLocalError)
    })
  })

  it("lists an event that a transition sends to the machine itself, for a later step", () => {
    const asked = success(step.send(success(step.start()).state, Events.Ask()))
    assert.strictEqual(leafOf(asked), "Asked")
    const sent = only(asked.sends)
    assert.strictEqual(sent.target, self)
    assert.deepStrictEqual(sent.event, { _tag: "Answer" })
    assert.strictEqual(leafOf(success(step.send(asked.state, sent.event as never))), "Idle")
  })

  it("stops every piece of work when its owner stops it", () => {
    const loading = success(step.send(success(step.start()).state, Events.Load({ id: "a" })))
    const stopped = step.stop(loading.state)
    assert.deepStrictEqual(stopped.stop.map(keyOf), loading.start.map(keyOf))
    assert.deepStrictEqual(stopped.exit, Exit.fail(new Machine.StoppedError()))
    assert.strictEqual(step.stop(stopped.state).state, stopped.state)
  })

  describe("streams", () => {
    const counter = Machine.make({
      root: Machine.state({ states: { Idle: {}, Counting: { fields: { total: Schema.Number } }, Done: {} } }),
      events: Machine.events({ Count: {}, Cancel: {} }),
      streams: { numbers: Stream.make(1, 2, 3) }
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Count: { target: "Counting", data: { total: 0 } } } },
        Counting: {
          invoke: {
            src: "numbers",
            onElement: { update: { Counting: ({ element, state }) => ({ total: state.total + element }) } },
            onDone: { target: "Done" }
          },
          on: { Cancel: { target: "Idle" } }
        },
        Done: {}
      }
    })
    const steps = Machine.toStep(counter, { self })

    it.effect("takes the elements of a stream one by one, and its end", () =>
      Effect.gen(function*() {
        const counting = success(steps.send(success(steps.start()).state, { _tag: "Count" }))
        const work = only(counting.start)
        if (work._tag !== "Stream") throw new Error(`Unexpected ${work._tag}`)
        let state = counting.state
        const totals: Array<unknown> = []
        const exit = yield* Effect.exit(Stream.runForEach(work.stream, (element) =>
          Effect.sync(() => {
            const taken = steps.element(state, work, element)
            state = taken.state
            totals.push(taken.snapshot.state.value)
          })))
        assert.deepStrictEqual(totals, [1, 3, 6].map((total) => ({ _tag: "Counting", total })))
        assert.strictEqual(leafOf(steps.settle(state, work, exit)), "Done")
      }))

    it("ignores an element of a stream whose state was exited", () => {
      const counting = success(steps.send(success(steps.start()).state, { _tag: "Count" }))
      const work = only(counting.start)
      if (work._tag !== "Stream") throw new Error(`Unexpected ${work._tag}`)
      const idle = success(steps.send(counting.state, { _tag: "Cancel" }))
      assert.strictEqual(steps.element(idle.state, work, 1).state, idle.state)
    })
  })

  describe("resume", () => {
    it.effect("starts the work of the active states once, with the initial event", () =>
      Effect.gen(function*() {
        const events: Array<unknown> = []
        const resumable = Machine.make({
          root: Machine.state({ states: { Idle: {}, Loading: { fields: { id: Schema.String } } } }),
          events: Machine.events({ Load: { id: Schema.String } }),
          effects: { load: (id: string) => Effect.succeed(id) }
        }).handle({
          initial: { target: "Idle" },
          states: {
            Idle: { on: { Load: { target: "Loading", data: ({ event }) => ({ id: event.id }) } } },
            Loading: {
              invoke: {
                src: "load",
                input: ({ event, state }) => {
                  events.push(event)
                  return state.id
                },
                onDone: { stay: true }
              }
            }
          }
        })
        const steps = Machine.toStep(resumable, { self })
        const loading = success(steps.send(success(steps.start()).state, { _tag: "Load", id: "a" }))
        const encoded = yield* Machine.encodeSnapshot(resumable, loading.snapshot)
        const resumed = success(steps.resume(yield* Machine.decodeSnapshot(resumable, encoded)))
        assert.deepStrictEqual(resumed.snapshot, loading.snapshot)
        assert.deepStrictEqual(resumed.start.map(keyOf), [{ _tag: "Effect", path: "Loading", id: "load", run: 0 }])
        assert.strictEqual(events.length, 2)
        assert.isTrue(Machine.isInitialEvent(events[1]))
      }))

    it("ends at once in a final snapshot, with its output", () => {
      const final = Machine.make({
        root: Machine.state({ states: { Closed: { type: "final", output: Schema.String } } }),
        events: Machine.events({})
      }).handle({ initial: { target: "Closed" }, states: { Closed: { output: () => "closed" } } })
      const steps = Machine.toStep(final, { self })
      const started = success(steps.start())
      assert.deepStrictEqual(started.exit, Exit.succeed("closed"))
      const resumed = success(steps.resume(started.snapshot))
      assert.deepStrictEqual(resumed.exit, Exit.succeed("closed"))
      assert.deepStrictEqual(resumed.start, [])
    })
  })
})
