import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { Machine } from "../../../src/index.js"
import * as ClusterWork from "../../../src/internal/machine/clusterWork.js"
import { toImpl } from "../../../src/internal/machine/implementation.js"
import { ClusterMachine } from "../../../src/unstable/cluster/index.js"

const root = Machine.state({ states: { Idle: {}, Busy: {} } })
const initial = { target: "Idle" } as const
const address = Machine.childAddress<never>("worker")
const child = Machine.make({ root, events: Machine.events({}) }).handle({ initial })

const definition = Machine.make({
  root,
  events: Machine.events({}),
  effects: { load: Effect.succeed(1), stop: Machine.stopChild(address) },
  timers: { wait: "1 second" },
  streams: { feed: Stream.make(1) },
  logic: { worker: Machine.logic({ initial: Effect.succeed(0), run: () => Effect.succeed(1) }) },
  children: { child: Machine.child("child", child) }
})

const options = { version: "1" }

const supportOf = (machine: Machine.Machine.Any) => ClusterWork.supportOf(toImpl(machine).handlers)

// `ClusterMachine.make` decides by types, and `supportOf` decides for machines
// without types. Every machine below is given to both.
describe("what ClusterMachine refuses at compile time and at run time", () => {
  it("agrees on each kind of invocation that a host may not support, and runs a child machine", () => {
    const refused = {
      Stream: definition.handle({
        initial,
        states: { Busy: { invoke: { src: "feed", onElement: { stay: true }, onDone: { stay: true } } } }
      }),
      Logic: definition.handle({
        initial,
        states: { Busy: { invoke: { src: "worker", id: "worker", address, onDone: { stay: true } } } }
      }),
      Child: definition.handle({ initial, states: { Busy: { invoke: { src: "child" } } } })
      // A kind that the types name and this record lacks does not compile.
    } satisfies Record<Machine.InvocationSupport.Kind, unknown>

    // @ts-expect-error { invocations: "Stream" }
    ClusterMachine.make("Stream", refused.Stream, options)
    // @ts-expect-error { invocations: "Logic" }
    ClusterMachine.make("Logic", refused.Logic, options)
    // A child machine runs as an entity of its own.
    ClusterMachine.make("Child", refused.Child, options)

    for (const [kind, machine] of Object.entries(refused)) {
      const support = supportOf(machine)
      if (kind === "Child") {
        assert.strictEqual(support._tag, "Hosted")
        continue
      }
      assert(support._tag === "Unsupported")
      assert.match(support.message, new RegExp(`^${kind} invocation ".*" of state "Busy"`))
    }
  })

  it("hosts the snapshots of a child machine", () => {
    const support = supportOf(
      definition.handle({ initial, states: { Busy: { invoke: { src: "child", onSnapshot: { stay: true } } } } })
    )
    assert.strictEqual(support._tag, "Hosted")
  })

  it("agrees on a machine of effects and timers", () => {
    const hosted = definition.handle({
      initial,
      states: {
        Busy: {
          invoke: [
            { src: "load", onDone: { stay: true } },
            { src: "wait", onDone: { stay: true } }
          ]
        }
      }
    })
    ClusterMachine.make("Hosted", hosted, options)
    assert.deepStrictEqual(supportOf(hosted), { _tag: "Hosted" })
  })

  it("agrees on a machine that registers unsupported sources and invokes none", () => {
    const idle = definition.handle({ initial })
    ClusterMachine.make("Idle", idle, options)
    assert.deepStrictEqual(supportOf(idle), { _tag: "Idle" })
  })

  it("agrees on a machine that mixes supported and unsupported invocations", () => {
    const mixed = definition.handle({
      initial,
      states: {
        Idle: { invoke: { src: "load", onDone: { stay: true } } },
        Busy: {
          invoke: [
            { src: "wait", onDone: { stay: true } },
            { src: "feed", onElement: { stay: true }, onDone: { stay: true } }
          ]
        }
      }
    })
    // @ts-expect-error { invocations: "Stream" }
    ClusterMachine.make("Mixed", mixed, options)
    assert.strictEqual(supportOf(mixed)._tag, "Unsupported")
  })

  it("leaves what the work itself requires to the types", () => {
    const stopping = definition.handle({
      initial,
      states: { Busy: { invoke: { src: "stop", onDone: { stay: true } } } }
    })
    // @ts-expect-error { capabilities: "MachineRuntime" }
    ClusterMachine.make("Stopping", stopping, options)
    // A value does not say which services its work requires.
    assert.deepStrictEqual(supportOf(stopping), { _tag: "Hosted" })
  })
})
