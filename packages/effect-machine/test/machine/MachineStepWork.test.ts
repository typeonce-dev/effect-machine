import { assert, describe, it } from "@effect/vitest"
import { Cause, Duration, Effect, Exit, Schema, Stream } from "effect"
import { Machine } from "../../src/index.js"

const success = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) throw new Error(`Expected a success, received ${Cause.pretty(exit.cause)}`)
  return exit.value
}

const only = <W>(work: ReadonlyArray<W>): W => {
  assert.strictEqual(work.length, 1)
  return work[0]!
}

const leafOf = (step: Machine.MachineStep.Step<any>): string =>
  (step.snapshot as unknown as { readonly state: { readonly path: string } }).state.path

const target = (id: string): Machine.MachineTarget<any> => ({ id, sessionId: `${id}:test`, send: () => Effect.void })

const self = target("machine")

const failureOf = (exit: Exit.Exit<unknown, unknown> | undefined): unknown => {
  if (exit === undefined || Exit.isSuccess(exit)) throw new Error("Expected a failed machine")
  return Cause.squash(exit.cause)
}

/** Children of a host, which records what work asks of them. */
const recording = () => {
  const calls: Array<string> = []
  const ref = null! as Machine.MachineRef<unknown, never, unknown, unknown, unknown>
  const children: Machine.MachineStep.Children = {
    spawn: (child, options) => Effect.sync(() => (calls.push(`spawn ${child.id} ${String(options?.input)}`), ref)),
    spawnLogic: (_, options) => Effect.sync(() => (calls.push(`spawnLogic ${options?.id}`), ref)),
    sendTo: (child, event) =>
      Effect.sync(() => {
        calls.push(`sendTo ${typeof child === "string" ? child : child.id} ${JSON.stringify(event)}`)
      }),
    stop: (child) => Effect.sync(() => calls.push(`stop ${typeof child === "string" ? child : child.id}`))
  }
  return { calls, children }
}

describe("Machine.toStep work", () => {
  describe("evaluation", () => {
    it("calls no source and no input mapper in a step, and each at most once when the host starts the work", () => {
      const calls: Array<string> = []
      const machine = Machine.make({
        root: Machine.state({ states: { Idle: {}, Busy: {} } }),
        events: Machine.events({ Go: {} }),
        effects: { load: (id: string) => (calls.push(`load ${id}`), Effect.succeed(id)) },
        timers: { wait: (seconds: number) => (calls.push(`wait ${seconds}`), Duration.seconds(seconds)) },
        streams: { feed: (n: number) => (calls.push(`feed ${n}`), Stream.make(n)) }
      }).handle({
        initial: { target: "Idle" },
        states: {
          Idle: { on: { Go: { target: "Busy" } } },
          Busy: {
            invoke: [
              { src: "load", input: () => (calls.push("map load"), "a"), onDone: { stay: true } },
              { src: "wait", input: () => (calls.push("map wait"), 5), onDone: { stay: true } },
              {
                src: "feed",
                input: () => (calls.push("map feed"), 1),
                onElement: { stay: true },
                onDone: { stay: true }
              }
            ]
          }
        }
      })
      const step = Machine.toStep(machine, { self })
      const busy = success(step.send(success(step.start()).state, { _tag: "Go" }))
      assert.deepStrictEqual(busy.start.map((work) => work._tag), ["Effect", "Timer", "Stream"])
      assert.deepStrictEqual(calls, [])

      const [load, wait, feed] = busy.start
      if (load?._tag !== "Effect" || wait?._tag !== "Timer" || feed?._tag !== "Stream") throw new Error("kinds")
      load.effect()
      load.effect()
      assert.deepStrictEqual(calls, ["map load", "load a"])
      assert.deepStrictEqual(wait.duration(), Exit.succeed(Duration.seconds(5)))
      wait.effect()
      wait.duration()
      feed.stream()
      feed.stream()
      assert.deepStrictEqual(calls, ["map load", "load a", "map wait", "wait 5", "map feed", "feed 1"])
    })

    describe("timers", () => {
      const machine = (after: () => Duration.Input) =>
        Machine.make({
          root: Machine.state({ states: { Waiting: {}, Expired: {} } }),
          events: Machine.events({}),
          timers: { wait: (_: string) => after() }
        }).handle({
          initial: { target: "Waiting" },
          states: { Waiting: { invoke: { src: "wait", input: () => "now", onDone: { target: "Expired" } } } }
        })

      it("cannot start a timer whose duration throws", () => {
        const step = Machine.toStep(
          machine(() => {
            throw new Error("no duration")
          }),
          { self }
        )
        const started = success(step.start())
        const timer = only(started.start)
        if (timer._tag !== "Timer") throw new Error(timer._tag)
        const duration = timer.duration()
        assert.isTrue(Exit.isFailure(duration))
        assert.isTrue(Exit.isFailure(timer.effect()))
        const failed = step.settle(started.state, timer, duration)
        assert.strictEqual((failureOf(failed.exit) as Error).message, "no duration")
      })

      it("cannot start a timer whose input names no duration, as one whose duration throws", () => {
        const step = Machine.toStep(machine(() => "soon" as Duration.Input), { self })
        const started = success(step.start())
        const timer = only(started.start)
        if (timer._tag !== "Timer") throw new Error(timer._tag)
        const duration = timer.duration()
        assert.isTrue(Exit.isFailure(duration) && Exit.hasDies(duration))
        assert.isTrue(Exit.isFailure(timer.effect()))
        const failed = step.settle(started.state, timer, duration)
        assert.isTrue(failed.exit !== undefined && Exit.hasDies(failed.exit))
        assert.strictEqual(leafOf(failed), "Waiting")
      })
    })
  })

  describe("logic", () => {
    const Counter = Machine.childAddress<number>("counter")
    const counter = Machine.logic<number, number, number>({ initial: 0, run: () => Effect.succeed(3) })
    const machine = Machine.make({
      root: Machine.state({ states: { Counting: { fields: { seen: Schema.Number } }, Done: {} } }),
      events: Machine.events({ Add: { by: Schema.Number }, Cancel: {} }),
      logic: { counter }
    }).handle({
      initial: { target: "Counting", data: { seen: 0 } },
      states: {
        Counting: {
          invoke: {
            src: "counter",
            id: "counter",
            address: Counter,
            onSnapshot: { update: { Counting: ({ snapshot }) => ({ seen: snapshot.state }) } },
            onDone: { target: "Done" }
          },
          on: {
            Add: { stay: true, commands: ({ event }, enqueue) => enqueue.sendTo(Counter, event.by) },
            Cancel: { stay: true, commands: (_, enqueue) => enqueue.stop(Counter) }
          }
        },
        Done: {}
      }
    })
    const step = Machine.toStep(machine, { self })

    it("describes process logic at its address, and takes the states it reports and its output", () => {
      const started = success(step.start())
      const work = only(started.start)
      if (work._tag !== "Logic") throw new Error(work._tag)
      assert.deepStrictEqual([work.path, work.id, work.address, work.source], [
        "Counting",
        "counter",
        "counter",
        "counter"
      ])
      assert.isTrue(Exit.isSuccess(work.logic()))

      const reported = step.report(started.state, work, 7)
      assert.deepStrictEqual(reported.snapshot.state.value, { _tag: "Counting", seen: 7 })
      assert.strictEqual(leafOf(step.settle(reported.state, work, Exit.succeed(3))), "Done")
    })

    it("lists the commands that address it, with the work they select", () => {
      const started = success(step.start())
      const work = only(started.start)
      if (work._tag !== "Logic") throw new Error(work._tag)
      const added = success(step.send(started.state, { _tag: "Add", by: 2 }))
      assert.deepStrictEqual(added.commands, [{ _tag: "SendToChild", child: Counter, work, event: 2 }])
      assert.deepStrictEqual(added.running, [work])

      const cancelled = success(step.send(added.state, { _tag: "Cancel" }))
      assert.deepStrictEqual(cancelled.commands, [{ _tag: "StopChild", child: Counter, work }])
      assert.deepStrictEqual(cancelled.stop, [])
      // The stopped logic no longer runs, so what it reports is ignored.
      assert.deepStrictEqual(cancelled.running, [])
      assert.strictEqual(step.report(cancelled.state, work, 9).state, cancelled.state)
    })
  })

  describe("child machines", () => {
    const Reports = Machine.events({ Reported: { count: Schema.Number } })
    const worker = Machine.make({
      id: "Worker",
      root: Machine.state({ states: { Working: {}, Done: { type: "final", output: Schema.String } } }),
      input: Schema.String,
      events: Machine.events({ Report: {}, Finish: {} }),
      parent: Machine.parent(Reports)
    }).handle({
      initial: { target: "Working" },
      states: {
        Working: {
          on: {
            Report: {
              stay: true,
              commands: ({ parent }, enqueue) => enqueue.sendTo(parent, { _tag: "Reported", count: 1 })
            },
            Finish: { target: "Done" }
          }
        },
        Done: { output: () => "done" }
      }
    })
    const Worker = Machine.child("worker", worker)
    const owner = Machine.make({
      root: Machine.state({
        states: { Hosting: { fields: { seen: Schema.String } }, Ready: { fields: { result: Schema.String } } }
      }),
      events: Machine.events({ Report: {}, Stop: {}, Reported: { count: Schema.Number } }),
      children: { worker: Worker }
    }).handle({
      initial: { target: "Hosting", data: { seen: "" } },
      states: {
        Hosting: {
          invoke: {
            src: "worker",
            input: () => "ada",
            onSnapshot: { update: { Hosting: ({ snapshot }) => ({ seen: snapshot.state.state.path }) } },
            onDone: { target: "Ready", data: ({ output }) => ({ result: output }) }
          },
          on: {
            Report: { stay: true, commands: (_, enqueue) => enqueue.sendTo(Worker, { _tag: "Report" }) },
            Stop: { stay: true, commands: (_, enqueue) => enqueue.stop(Worker) }
          }
        },
        Ready: {}
      }
    })
    const step = Machine.toStep(owner, { self })

    it("describes a child machine by its descriptor and input, and takes its snapshots and output", () => {
      const started = success(step.start())
      const work = only(started.start)
      if (work._tag !== "Child") throw new Error(work._tag)
      assert.strictEqual(work.child, Worker)
      assert.deepStrictEqual(work.input(), Exit.succeed(["ada"]))

      const child = Machine.toStep(worker, { self: target("worker"), parent: self })
      const working = success(child.start(...(success(work.input()) as [string])))
      const reported = step.report(started.state, work, working.snapshot)
      assert.deepStrictEqual(reported.snapshot.state.value, { _tag: "Hosting", seen: "Working" })

      const done = child.send(working.state, { _tag: "Finish" })
      assert.deepStrictEqual(success(done).exit, Exit.succeed("done"))
      const ready = step.settle(reported.state, work, success(done).exit!)
      assert.deepStrictEqual(ready.snapshot.state.value, { _tag: "Ready", result: "done" })
    })

    it("fails with a child that fails, also when the failure belongs to its framework", () => {
      const started = success(step.start())
      const work = only(started.start)
      const broken = step.settle(started.state, work, Exit.die(new Error("broken worker")))
      assert.strictEqual((failureOf(broken.exit) as Error).message, "broken worker")
      const stopped = step.settle(started.state, work, Exit.fail(new Machine.StoppedError()))
      assert.instanceOf(failureOf(stopped.exit), Machine.StoppedError)
    })

    it("lists the commands that address it, and stops it as one of them asks", () => {
      const started = success(step.start())
      const work = only(started.start)
      if (work._tag !== "Child") throw new Error(work._tag)
      const reported = success(step.send(started.state, { _tag: "Report" }))
      assert.deepStrictEqual(reported.commands, [{
        _tag: "SendToChild",
        child: Worker,
        work,
        event: { _tag: "Report" }
      }])
      const stopped = success(step.send(reported.state, { _tag: "Stop" }))
      assert.deepStrictEqual(stopped.commands, [{ _tag: "StopChild", child: Worker, work }])
      assert.deepStrictEqual(stopped.running, [])
    })

    it("gives a child the parent that its host passes, as a target its transitions send to", () => {
      const parent = target("owner")
      const child = Machine.toStep(worker, { self: target("worker"), parent })
      const working = success(child.start("ada"))
      const reported = success(child.send(working.state, { _tag: "Report" }))
      assert.deepStrictEqual(reported.commands, [{
        _tag: "Send",
        target: parent,
        event: { _tag: "Reported", count: 1 }
      }])
    })
  })

  describe("children of the host", () => {
    it.effect("gives work the children that its host supplies", () =>
      Effect.gen(function*() {
        const { calls, children } = recording()
        const Worker = Machine.childFamily(
          Machine.make({
            root: Machine.state({ states: { Idle: {} } }),
            events: Machine.events({ Ping: {} }),
            input: Schema.String
          }).handle({ initial: { target: "Idle" } })
        )
        const machine = Machine.make({
          root: Machine.state({ states: { Idle: {}, Working: {} } }),
          events: Machine.events({ Go: {} }),
          effects: {
            spawn: (owner: Machine.ChildOwner<never>) => Effect.orDie(owner.spawn(Worker("first"), { input: "a" })),
            ping: Effect.orDie(Machine.sendTo(Worker("first"), { _tag: "Ping" })),
            close: Machine.stopChild(Worker("first"))
          }
        }).handle({
          initial: { target: "Idle" },
          states: {
            Idle: { on: { Go: { target: "Working" } } },
            Working: {
              invoke: [
                { src: "spawn", input: ({ children }) => children, onDone: { stay: true } },
                { src: "ping", onDone: { stay: true } },
                { src: "close", onDone: { stay: true } }
              ]
            }
          }
        })
        const step = Machine.toStep(machine, { self, children })
        const working = success(step.send(success(step.start()).state, { _tag: "Go" }))
        for (const work of working.start) {
          if (work._tag !== "Effect") throw new Error(work._tag)
          yield* success(work.effect())
        }
        assert.deepStrictEqual(calls, ["spawn first a", "sendTo first {\"_tag\":\"Ping\"}", "stop first"])
      }))

    it.effect("refuses an operation on children when its host supplies none", () =>
      Effect.gen(function*() {
        const machine = Machine.make({
          root: Machine.state({ states: { Working: {} } }),
          events: Machine.events({}),
          effects: { spawn: (owner: Machine.ChildOwner<never>) => owner.stop(Machine.child("x", null!)) }
        }).handle({
          initial: { target: "Working" },
          states: { Working: { invoke: { src: "spawn", input: ({ children }) => children, onDone: { stay: true } } } }
        })
        const step = Machine.toStep(machine, { self })
        const work = only(success(step.start()).start)
        if (work._tag !== "Effect") throw new Error(work._tag)
        const exit = yield* Effect.exit(success(work.effect()))
        assert.isTrue(Exit.isFailure(exit))
        if (Exit.isFailure(exit)) assert.instanceOf(Cause.squash(exit.cause), Machine.ProcessLocalError)
      }))
  })

  describe("resume", () => {
    const machine = Machine.make({
      root: Machine.state({ states: { Working: {}, Done: {} } }),
      events: Machine.events({}),
      effects: { first: Effect.void, second: Effect.void, third: Effect.void }
    }).handle({
      initial: { target: "Working" },
      states: {
        Working: {
          invoke: [
            { src: "first", onDone: { stay: true } },
            { src: "second", onDone: { target: "Done" } },
            { src: "third", onDone: { stay: true } }
          ]
        },
        Done: {}
      }
    })
    const step = Machine.toStep(machine, { self })

    it("starts no work that ended, and keeps work that runs without starting it", () => {
      const started = success(step.start())
      const resumed = success(step.resume(started.snapshot, [
        { path: "Working", id: "first", status: "Ended" },
        { path: "Working", id: "second", status: "Running" }
      ]))
      assert.deepStrictEqual(resumed.start.map(({ id }) => id), ["third"])
      assert.deepStrictEqual(resumed.running.map(({ id }) => id), ["second", "third"])
      const second = resumed.running.find(({ id }) => id === "second")!
      assert.strictEqual(leafOf(step.settle(resumed.state, second, Exit.void)), "Done")
    })

    it("keeps work that runs in its start order among the work that starts", () => {
      const resumed = success(step.resume(success(step.start()).snapshot, [
        { path: "Working", id: "second", status: "Running" }
      ]))
      assert.deepStrictEqual(resumed.start.map(({ id }) => id), ["first", "third"])
      assert.deepStrictEqual(resumed.running.map(({ id }) => id), ["first", "second", "third"])
      // Work stops latest first when the machine ends.
      assert.deepStrictEqual(step.stop(resumed.state).stop.map(({ id }) => id), ["third", "second", "first"])
    })

    it("starts every piece of work without progress", () => {
      const resumed = success(step.resume(success(step.start()).snapshot))
      assert.deepStrictEqual(resumed.start.map(({ id }) => id), ["first", "second", "third"])
    })
  })

  describe("what hosts publish", () => {
    const Events = Machine.events({ Go: {} })
    const machine = Machine.make({
      root: Machine.state({ states: { Idle: {}, Passing: {}, Ready: {} } }),
      events: Events
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Go: { target: "Passing" } } },
        Passing: { always: { target: "Ready" } },
        Ready: {}
      }
    })
    const step = Machine.toStep(machine, { self })

    it("carries the decoded event and the microsteps of the plan", () => {
      const started = success(step.start())
      assert.isTrue(started.event !== undefined && Machine.isInitialEvent(started.event))
      const ready = success(step.send(started.state, Events.Go()))
      assert.deepStrictEqual(ready.event, { _tag: "Go" })
      assert.deepStrictEqual(
        ready.microsteps.map(({ entryPaths, exitPaths, next }) => ({
          exitPaths,
          entryPaths,
          leaf: (next as unknown as { readonly state: { readonly path: string } }).state.path
        })),
        [
          { exitPaths: ["Idle"], entryPaths: ["Passing"], leaf: "Passing" },
          { exitPaths: ["Passing"], entryPaths: ["Ready"], leaf: "Ready" }
        ]
      )
      assert.deepStrictEqual(step.stop(ready.state).event, undefined)
    })

    it("builds the snapshot once, on first read, without changing the state", () => {
      const started = success(step.start())
      const unread = success(step.send(started.state, Events.Go()))
      const read = success(step.send(started.state, Events.Go()))
      const snapshot = read.snapshot
      assert.strictEqual(read.snapshot, snapshot)
      assert.strictEqual(read.state, read.state)
      assert.deepStrictEqual(unread.state, read.state)
      assert.deepStrictEqual(snapshot, read.microsteps.at(-1)!.next)
    })
  })
})
