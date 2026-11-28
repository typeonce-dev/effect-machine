import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Exit, Schema, Stream } from "effect"
import { Machine } from "../../../src/index.js"
import * as Configuration from "../../../src/internal/machine/configuration.js"
import * as InvocationChanges from "../../../src/internal/machine/invocationChanges.js"
import * as InvocationResolution from "../../../src/internal/machine/invocationResolution.js"
import * as Planner from "../../../src/internal/machine/planner.js"

const refused = new Error("This host owns no children")

/** Capabilities of a host that owns no children. */
const capabilities = {
  self: { id: "resolution", sessionId: "resolution:1", send: () => Effect.void },
  parent: undefined,
  children: {
    spawn: () => Effect.die(refused),
    sendTo: () => Effect.die(refused),
    stop: () => Effect.die(refused)
  }
} satisfies InvocationResolution.InvocationCapabilities

/**
 * Plans one event from the initial state, and resolves the work of the states
 * it entered as a host does, one path at a time, without constructing a source.
 */
const enter = (machine: Machine.Machine.Any, event: Machine.Machine.EventOf<any>) => {
  const initial = Planner.planInitialSync(machine)
  const planned = Planner.planConfiguration(
    machine,
    Configuration.normalizeConfigurationSync(machine, initial.state),
    event
  )
  const changes = InvocationChanges.fromMicrosteps(planned.microsteps)
  const groups = Array.from(changes?.entered ?? []).flatMap(([path, entered]) =>
    InvocationResolution.resolve(machine, planned.next, [path], entered, capabilities)
  )
  return {
    configuration: planned.next,
    groups,
    invocations: groups.flatMap(({ invocations }) => invocations),
    value: (path: string) => planned.next.values.get(path)
  }
}

describe("invocation resolution of a step", () => {
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
    const entered = enter(machine, ParallelEvents.Go())
    // Shallower states start first, then document order, one group per state.
    assert.deepStrictEqual(entered.groups.map(({ invocations, path }) => [path, invocations.map(({ id }) => id)]), [
      ["Active.right", ["regionWork"]],
      ["Active.left.Busy", ["leftWork"]],
      ["Active.right.Busy", ["rightWork"]]
    ])

    // Order, filtering, and grouping do not depend on the paths a host passes.
    const groups = InvocationResolution.resolve(
      machine,
      entered.configuration,
      ["Idle", "Active.right.Busy", "Active.left.Busy", "Active.right.Busy", "Active.left", "Active.right"],
      ParallelEvents.Go(),
      capabilities
    )
    assert.deepStrictEqual(groups.map(({ invocations, path }) => [path, invocations.map(({ id }) => id)]), [
      ["Active.right", ["regionWork"]],
      ["Active.left.Busy", ["leftWork"]],
      ["Active.right.Busy", ["rightWork"]]
    ])
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
    return { calls, contexts, ...enter(machine, SourceEvents.Go({ value: 5 })) }
  }

  const find = <Tag extends InvocationResolution.ResolvedInvocation["_tag"]>(
    started: ReadonlyArray<InvocationResolution.ResolvedInvocation>,
    tag: Tag,
    id: string
  ): Extract<InvocationResolution.ResolvedInvocation, { readonly _tag: Tag }> => {
    const found = started.find((invocation) => invocation.id === id)
    if (found?._tag !== tag) throw new Error(`Expected ${tag} "${id}", received ${String(found?._tag)}`)
    return found as Extract<InvocationResolution.ResolvedInvocation, { readonly _tag: Tag }>
  }

  it("describes every source kind in declaration order without constructing a source", () => {
    const { calls, invocations: started } = makeHost()
    assert.deepStrictEqual(started.map((invocation) => [invocation._tag, invocation.id]), [
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
    assert.deepStrictEqual(started.map((invocation) => invocation.channels.element), [
      false,
      true,
      ...Array.from({ length: 7 }, () => false)
    ])
    assert.isTrue(find(started, "Logic", "logic").channels.snapshot)
    assert.isFalse(find(started, "Child", "plain-child").channels.done)
  })

  it.effect("constructs sources with the entry context and the host's capabilities", () =>
    Effect.gen(function*() {
      const { calls, contexts, invocations: started, value } = makeHost()
      const effect = find(started, "Effect", "effect").effect()
      assert.deepStrictEqual(calls, ["effect input", "effect source"])
      assert.strictEqual(yield* (effect as Effect.Effect<unknown>), 5)
      const context = contexts[0]!
      assert.strictEqual(context.self, capabilities.self)
      assert.strictEqual(context.parent, undefined)
      assert.strictEqual(context.children, capabilities.children)
      assert.strictEqual(context.state, value("Busy"))
      assert.strictEqual(context.root, value(""))
      assert.strictEqual(context.containingState, value(""))
      assert.deepStrictEqual(context.ancestors, { "": value("") })
      assert.strictEqual((context.event as { readonly _tag: string })._tag, "Go")

      const stream = find(started, "Stream", "stream").stream()
      assert.deepStrictEqual(yield* Stream.runCollect(stream as Stream.Stream<unknown>), [5])
      const process = find(started, "Logic", "logic")
      assert.strictEqual(process.address, "logic-address")
      assert.isTrue(Object.is(process.logic(), logic))
    }))

  it("describes a child by its descriptor and declared input", () => {
    const { invocations: started } = makeHost()
    const withInput = find(started, "Child", "input-child")
    assert.strictEqual(withInput.child, InputChild)
    assert.strictEqual(withInput.input?.(), 6)
    const withoutInput = find(started, "Child", "plain-child")
    assert.strictEqual(withoutInput.child, PlainChild)
    assert.strictEqual(withoutInput.input, undefined)
  })

  it("separates a throwing timer source from an input that names no duration", () => {
    const { calls, invocations: started } = makeHost()
    assert.deepStrictEqual(find(started, "Timer", "fixed").duration(), Exit.succeed(Duration.seconds(2)))
    assert.deepStrictEqual(find(started, "Timer", "mapped").duration(), Exit.succeed(Duration.millis(5)))
    assert.deepStrictEqual(calls, ["timer input", "timer source"])
    assert.throws(() => find(started, "Timer", "throwing").duration(), "timer source")
    const invalid = find(started, "Timer", "invalid").duration()
    assert.isTrue(Exit.hasDies(invalid))
  })
})
