import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Exit, Schema, Stream } from "effect"
import { Machine } from "../../../src/index.js"
import * as Configuration from "../../../src/internal/machine/configuration.js"
import * as InvocationChanges from "../../../src/internal/machine/invocationChanges.js"
import type * as InvocationEvent from "../../../src/internal/machine/invocationEvent.js"
import { InvocationGenerations } from "../../../src/internal/machine/invocationGeneration.js"
import * as InvocationOutcome from "../../../src/internal/machine/invocationOutcome.js"
import * as InvocationResolution from "../../../src/internal/machine/invocationResolution.js"
import * as Planner from "../../../src/internal/machine/planner.js"

/** One invocation a host has to run, with the generation of its group. */
interface Started {
  readonly invocation: InvocationResolution.ResolvedInvocation
  readonly generation: InvocationEvent.Generation
}

const refused = new Error("This host owns no children")

/**
 * A host without a runtime. It plans events, keeps generations, and lists the
 * invocations to run, which each test runs and settles in its own order.
 */
class PlannedHost {
  readonly generations = new InvocationGenerations()
  readonly sent: Array<unknown> = []
  readonly self: Machine.MachineTarget<any> = {
    id: "planned-host",
    sessionId: "planned-host:1",
    send: (event) => Effect.sync(() => void this.sent.push(event))
  }
  readonly children: Machine.ChildOwner<any> = {
    spawn: () => Effect.die(refused),
    sendTo: () => Effect.die(refused),
    stop: () => Effect.die(refused)
  }
  readonly started: ReadonlyArray<Started>
  private configuration: Configuration.ActiveConfiguration

  constructor(private readonly machine: Machine.Machine.Any) {
    const planned = Planner.planInitialSync(machine)
    this.configuration = Configuration.normalizeConfigurationSync(machine, planned.state)
    this.started = this.start(
      Configuration.getInitialEntryPaths(machine, this.configuration),
      Planner.InitialEvent
    )
  }

  get leaves(): ReadonlyArray<string> {
    return Configuration.getActiveLeafPaths(this.machine, this.configuration)
  }

  value(path: string): unknown {
    return this.configuration.values.get(path)
  }

  resolve(
    paths: ReadonlyArray<string>,
    event: Machine.Machine.LifecycleEvent<any>
  ): ReadonlyArray<InvocationResolution.InvocationGroup> {
    return InvocationResolution.resolve(this.machine, this.configuration, paths, event, {
      self: this.self,
      parent: undefined,
      children: this.children
    })
  }

  private start(
    paths: ReadonlyArray<string>,
    event: Machine.Machine.LifecycleEvent<any>
  ): ReadonlyArray<Started> {
    return this.resolve(paths, event).flatMap((group) => {
      const generation = this.generations.beginGeneration(group.path)
      return group.invocations.map((invocation) => ({ invocation, generation }))
    })
  }

  /** Plans one event and returns the invocations it starts. */
  send(event: object): ReadonlyArray<Started> {
    const planned = Planner.planConfiguration(this.machine, this.configuration, event)
    this.configuration = planned.next
    const changes = InvocationChanges.fromMicrosteps(planned.microsteps)
    this.generations.retireGenerations(changes?.exited ?? [])
    if (planned.done) {
      this.generations.retireAllGenerations()
      return []
    }
    return Array.from(changes?.entered ?? []).flatMap(([path, event]) => this.start([path], event))
  }

  /** Performs a decision and returns the invocations it starts. */
  perform(decision: InvocationOutcome.Decision): ReadonlyArray<Started> {
    switch (decision._tag) {
      case "Deliver":
        return this.send(decision.event)
      case "Fail":
        throw new Error("The host failed its machine", { cause: decision.cause })
      case "Ignore":
        return []
    }
  }
}

const decide = (started: Started, outcome: InvocationOutcome.Outcome): InvocationOutcome.Decision =>
  InvocationOutcome.decide(started.invocation, started.generation, outcome)

const only = (started: ReadonlyArray<Started>): Started => {
  assert.strictEqual(started.length, 1)
  return started[0]!
}

/** Runs the effect of one started invocation. */
const runEffect = (started: Started): Effect.Effect<InvocationOutcome.Outcome> =>
  Effect.suspend(() => {
    if (started.invocation._tag !== "Effect") return Effect.die(new Error(`Unexpected ${started.invocation._tag}`))
    return (started.invocation.effect() as Effect.Effect<unknown, unknown>).pipe(
      Effect.exit,
      Effect.map(InvocationOutcome.fromExit)
    )
  })

const Events = Machine.events({ Load: { id: Schema.String }, Cancel: {}, Wait: {} })

const loader = Machine.make({
  id: "loader",
  root: Machine.state({
    states: {
      Idle: {},
      Loading: { fields: { id: Schema.String } },
      Waiting: {},
      Loaded: { fields: { result: Schema.String } },
      Failed: { fields: { reason: Schema.String } },
      TimedOut: {}
    }
  }),
  events: Events,
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
        Wait: { target: "Waiting" }
      }
    },
    Loading: {
      invoke: {
        src: "load",
        input: ({ state }) => state.id,
        onDone: { target: "Loaded", data: ({ output }) => ({ result: output }) },
        onFailure: { target: "Failed", data: ({ error }) => ({ reason: error.reason }) }
      },
      on: { Cancel: { target: "Idle" } }
    },
    Waiting: { invoke: { src: "wait", input: () => 90, onDone: { target: "TimedOut" } } },
    Loaded: {},
    Failed: {},
    TimedOut: {}
  }
})

describe("a host that is not the local runtime", () => {
  it.effect("runs an effect and routes its output through onDone", () =>
    Effect.gen(function*() {
      const host = new PlannedHost(loader)
      assert.deepStrictEqual(host.leaves, ["Idle"])
      assert.deepStrictEqual(host.started, [])

      const loading = only(host.send(Events.Load({ id: "a" })))
      assert.deepStrictEqual(host.leaves, ["Loading"])
      if (loading.invocation._tag !== "Effect") throw new Error(`Unexpected ${loading.invocation._tag}`)
      assert.strictEqual(loading.invocation.path, "Loading")
      assert.strictEqual(loading.invocation.id, "load")
      assert.strictEqual(loading.invocation.sourceName, "load")
      assert.deepStrictEqual(loading.invocation.channels, {
        done: true,
        failure: true,
        element: false,
        snapshot: false
      })

      const outcome = yield* runEffect(loading)
      assert.deepStrictEqual(host.perform(decide(loading, outcome)), [])
      assert.deepStrictEqual(host.leaves, ["Loaded"])
      assert.deepStrictEqual(host.value("Loaded"), { _tag: "Loaded", result: "document a" })
      assert.isFalse(loading.generation.current)
    }))

  it.effect("routes a typed failure through onFailure", () =>
    Effect.gen(function*() {
      const host = new PlannedHost(loader)
      const loading = only(host.send(Events.Load({ id: "missing" })))
      host.perform(decide(loading, yield* runEffect(loading)))
      assert.deepStrictEqual(host.leaves, ["Failed"])
      assert.deepStrictEqual(host.value("Failed"), { _tag: "Failed", reason: "not found" })
    }))

  it("reads a timer's duration as data and completes it without sleeping", () => {
    const host = new PlannedHost(loader)
    const waiting = only(host.send(Events.Wait()))
    if (waiting.invocation._tag !== "Timer") throw new Error(`Unexpected ${waiting.invocation._tag}`)
    assert.deepStrictEqual(waiting.invocation.duration(), Exit.succeed(Duration.seconds(90)))
    host.perform(decide(waiting, { _tag: "Done", output: undefined }))
    assert.deepStrictEqual(host.leaves, ["TimedOut"])
  })

  it("ignores the outcome of an exited state", () => {
    const host = new PlannedHost(loader)
    const loading = only(host.send(Events.Load({ id: "a" })))
    // Decided while its state was active, then queued behind the exit.
    const queued = decide(loading, { _tag: "Done", output: "document a" })
    assert.strictEqual(queued._tag, "Deliver")

    host.send(Events.Cancel())
    assert.deepStrictEqual(host.leaves, ["Idle"])
    assert.isFalse(loading.generation.current)
    assert.deepStrictEqual(host.perform(queued), [])
    assert.deepStrictEqual(host.leaves, ["Idle"])

    // Decided after the exit.
    assert.deepStrictEqual(decide(loading, { _tag: "Done", output: "document a" }), { _tag: "Ignore" })
  })

  it.effect("ignores a stale outcome after the same path and id are entered again", () =>
    Effect.gen(function*() {
      const host = new PlannedHost(loader)
      const first = only(host.send(Events.Load({ id: "first" })))
      const queued = decide(first, yield* runEffect(first))
      host.send(Events.Cancel())
      const second = only(host.send(Events.Load({ id: "second" })))
      assert.strictEqual(second.invocation.path, first.invocation.path)
      assert.strictEqual(second.invocation.id, first.invocation.id)

      host.perform(queued)
      assert.deepStrictEqual(host.leaves, ["Loading"])
      assert.isTrue(second.generation.current)

      host.perform(decide(second, yield* runEffect(second)))
      assert.deepStrictEqual(host.value("Loaded"), { _tag: "Loaded", result: "document second" })
    }))

  it("starts the invocations of one state in declaration order within one generation", () => {
    const States = Machine.state({ states: { Working: {}, Done: {} } })
    const machine = Machine.make({
      root: States,
      events: Machine.events({}),
      effects: { zeta: Effect.void, alpha: Effect.void }
    }).handle({
      initial: { target: "Working" },
      states: {
        Working: {
          invoke: [
            { src: "zeta", onDone: { stay: true } },
            { src: "alpha", onDone: { target: "Done" } }
          ]
        },
        Done: {}
      }
    })
    const host = new PlannedHost(machine)
    const [zeta, alpha] = host.started
    assert.deepStrictEqual(host.started.map(({ invocation }) => invocation.id), ["zeta", "alpha"])
    assert.strictEqual(zeta!.generation, alpha!.generation)

    // The generation outlives the first outcome and ends with the state.
    host.perform(decide(zeta!, { _tag: "Done", output: undefined }))
    assert.isTrue(alpha!.generation.current)
    host.perform(decide(alpha!, { _tag: "Done", output: undefined }))
    assert.deepStrictEqual(host.leaves, ["Done"])
    assert.isFalse(alpha!.generation.current)
  })

  it("groups a parallel step by entered state in entry order", () => {
    const States = Machine.state({
      states: {
        Idle: {},
        Active: {
          type: "parallel",
          states: {
            left: { states: { Busy: {} } },
            right: { states: { Busy: {} } }
          }
        }
      }
    })
    const ParallelEvents = Machine.events({ Go: {}, Stop: {} })
    const machine = Machine.make({
      root: States,
      events: ParallelEvents,
      effects: { leftWork: Effect.void, rightWork: Effect.void, regionWork: Effect.void }
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Go: { target: "Active" } } },
        Active: {
          on: { Stop: { target: "Idle" } },
          states: {
            left: {
              initial: { target: "Active.left.Busy" },
              states: { Busy: { invoke: { src: "leftWork", onDone: { stay: true } } } }
            },
            right: {
              invoke: { src: "regionWork", onDone: { stay: true } },
              initial: { target: "Active.right.Busy" },
              states: { Busy: { invoke: { src: "rightWork", onDone: { stay: true } } } }
            }
          }
        }
      }
    })
    const host = new PlannedHost(machine)
    const started = host.send(ParallelEvents.Go())
    // Shallower states start first, then document order.
    assert.deepStrictEqual(started.map(({ invocation }) => [invocation.path, invocation.id]), [
      ["Active.right", "regionWork"],
      ["Active.left.Busy", "leftWork"],
      ["Active.right.Busy", "rightWork"]
    ])
    assert.strictEqual(new Set(started.map(({ generation }) => generation)).size, 3)

    // Order, filtering, and grouping do not depend on the paths a host passes.
    const groups = host.resolve(
      ["Idle", "Active.right.Busy", "Active.left.Busy", "Active.right.Busy", "Active.left", "Active.right"],
      ParallelEvents.Go()
    )
    assert.deepStrictEqual(groups.map(({ invocations, path }) => [path, invocations.map(({ id }) => id)]), [
      ["Active.right", ["regionWork"]],
      ["Active.left.Busy", ["leftWork"]],
      ["Active.right.Busy", ["rightWork"]]
    ])

    host.send(ParallelEvents.Stop())
    assert.deepStrictEqual(started.map(({ generation }) => generation.current), [false, false, false])
  })
})

describe("invocation changes", () => {
  it("keeps the event that last entered each path, in entry order", () => {
    const event = (tag: string) => ({ _tag: tag }) as any
    const changes = InvocationChanges.fromMicrosteps([
      { event: event("Go"), exitPaths: ["Idle"], entryPaths: ["Busy", "Busy.left"], changed: true },
      { event: event("Ignored"), exitPaths: ["Busy"], entryPaths: ["Idle"], changed: false },
      { event: event("Again"), exitPaths: ["Busy.left", "Busy"], entryPaths: ["Busy", "Busy.right"], changed: true }
    ])
    assert.deepStrictEqual(changes?.exited, ["Idle", "Busy.left", "Busy"])
    assert.deepStrictEqual(Array.from(changes?.entered ?? []), [
      ["Busy", event("Again")],
      ["Busy.left", event("Go")],
      ["Busy.right", event("Again")]
    ])
  })

  it("reads no change from a step that stays in its states", () => {
    const step = { event: { _tag: "Note" } as any, exitPaths: [], entryPaths: [], changed: false }
    assert.strictEqual(InvocationChanges.fromMicrosteps([]), undefined)
    assert.strictEqual(InvocationChanges.fromMicrosteps([step, step]), undefined)
  })
})

describe("resolved invocations", () => {
  const SourceEvents = Machine.events({ Go: { value: Schema.Number } })
  const worker = Machine.make({
    root: Machine.state({ states: { Working: {} } }),
    input: Schema.Number,
    events: Machine.events({})
  }).handle({ initial: { target: "Working" }, states: { Working: {} } })
  const plainWorker = Machine.make({
    root: Machine.state({ states: { Working: {} } }),
    events: Machine.events({})
  }).handle({ initial: { target: "Working" }, states: { Working: {} } })
  const InputChild = Machine.child("input-child", worker)
  const PlainChild = Machine.child("plain-child", plainWorker)
  const logic = Machine.logic({ initial: 0, run: () => Effect.never })

  const makeHost = () => {
    const calls: Array<string> = []
    const contexts: Array<Record<string, unknown>> = []
    const machine = Machine.make({
      root: Machine.state({
        fields: { owner: Schema.String },
        states: { Idle: {}, Busy: { fields: { value: Schema.Number } } }
      }),
      events: SourceEvents,
      effects: {
        effect: (value: number) => {
          calls.push("effect source")
          return Effect.succeed(value)
        }
      },
      streams: { stream: (value: number) => Stream.make(value) },
      timers: {
        fixed: "2 seconds",
        mapped: (value: number) => {
          calls.push("timer source")
          return Duration.millis(value)
        },
        throwing: (_: number): Duration.Input => {
          throw new Error("timer source")
        },
        invalid: (value: number): Duration.Input => `${value / 0} seconds`
      },
      logic: { logic: (_: number) => logic },
      children: { input: InputChild, plain: PlainChild }
    }).handle({
      root: () => ({ owner: "host" }),
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Go: { target: "Busy", data: ({ event }) => ({ value: event.value }) } } },
        Busy: {
          invoke: [
            {
              src: "effect",
              input: (context) => {
                calls.push("effect input")
                contexts.push(context)
                return context.state.value
              },
              onDone: { stay: true }
            },
            { src: "stream", input: ({ state }) => state.value, onDone: { stay: true }, onElement: { stay: true } },
            { src: "fixed", onDone: { stay: true } },
            {
              src: "mapped",
              input: ({ state }) => {
                calls.push("timer input")
                return state.value
              },
              onDone: { stay: true }
            },
            { src: "throwing", input: ({ state }) => state.value, onDone: { stay: true } },
            { src: "invalid", input: ({ state }) => state.value, onDone: { stay: true } },
            {
              src: "logic",
              id: "logic",
              input: ({ state }) => state.value,
              address: Machine.childAddress("logic-address"),
              onSnapshot: { stay: true }
            },
            { src: "input", input: ({ event }) => event._tag === "Go" ? event.value + 1 : 0 },
            { src: "plain" }
          ]
        }
      }
    })
    const host = new PlannedHost(machine)
    return { host, calls, contexts, started: host.send(SourceEvents.Go({ value: 5 })) }
  }

  const find = <Tag extends InvocationResolution.ResolvedInvocation["_tag"]>(
    started: ReadonlyArray<Started>,
    tag: Tag,
    id: string
  ): Extract<InvocationResolution.ResolvedInvocation, { readonly _tag: Tag }> => {
    const found = started.find(({ invocation }) => invocation.id === id)?.invocation
    if (found?._tag !== tag) throw new Error(`Expected ${tag} "${id}", received ${String(found?._tag)}`)
    return found as Extract<InvocationResolution.ResolvedInvocation, { readonly _tag: Tag }>
  }

  it("describes every source kind in declaration order without constructing a source", () => {
    const { calls, started } = makeHost()
    assert.deepStrictEqual(started.map(({ invocation }) => [invocation._tag, invocation.id]), [
      ["Effect", "effect"],
      ["Stream", "stream"],
      ["Timer", "fixed"],
      ["Timer", "mapped"],
      ["Timer", "throwing"],
      ["Timer", "invalid"],
      ["Logic", "logic"],
      ["Child", "input-child"],
      ["Child", "plain-child"]
    ])
    assert.deepStrictEqual(calls, [])
    assert.deepStrictEqual(started.map(({ invocation }) => invocation.channels.element), [
      false,
      true,
      ...Array.from({ length: 7 }, () => false)
    ])
    assert.isTrue(find(started, "Logic", "logic").channels.snapshot)
    assert.isFalse(find(started, "Child", "plain-child").channels.done)
  })

  it.effect("constructs sources with the entry context and the host's capabilities", () =>
    Effect.gen(function*() {
      const { calls, contexts, host, started } = makeHost()
      const effect = find(started, "Effect", "effect").effect()
      assert.deepStrictEqual(calls, ["effect input", "effect source"])
      assert.strictEqual(yield* (effect as Effect.Effect<unknown>), 5)
      const context = contexts[0]!
      assert.strictEqual(context.self, host.self)
      assert.strictEqual(context.parent, undefined)
      assert.strictEqual(context.children, host.children)
      assert.strictEqual(context.state, host.value("Busy"))
      assert.strictEqual(context.root, host.value(""))
      assert.strictEqual(context.containingState, host.value(""))
      assert.deepStrictEqual(context.ancestors, { "": host.value("") })
      assert.strictEqual((context.event as { readonly _tag: string })._tag, "Go")

      const stream = find(started, "Stream", "stream").stream()
      assert.deepStrictEqual(yield* Stream.runCollect(stream as Stream.Stream<unknown>), [5])
      const process = find(started, "Logic", "logic")
      assert.strictEqual(process.address, "logic-address")
      assert.isTrue(Object.is(process.logic(), logic))
    }))

  it("describes a child by its descriptor and declared input", () => {
    const { started } = makeHost()
    const withInput = find(started, "Child", "input-child")
    assert.strictEqual(withInput.child, InputChild)
    assert.strictEqual(withInput.input?.(), 6)
    const withoutInput = find(started, "Child", "plain-child")
    assert.strictEqual(withoutInput.child, PlainChild)
    assert.strictEqual(withoutInput.input, undefined)
  })

  it("separates a throwing timer source from an input that names no duration", () => {
    const { calls, started } = makeHost()
    assert.deepStrictEqual(find(started, "Timer", "fixed").duration(), Exit.succeed(Duration.seconds(2)))
    assert.deepStrictEqual(find(started, "Timer", "mapped").duration(), Exit.succeed(Duration.millis(5)))
    assert.deepStrictEqual(calls, ["timer input", "timer source"])
    assert.throws(() => find(started, "Timer", "throwing").duration(), "timer source")
    const invalid = find(started, "Timer", "invalid").duration()
    assert.isTrue(Exit.hasDies(invalid))
  })
})
