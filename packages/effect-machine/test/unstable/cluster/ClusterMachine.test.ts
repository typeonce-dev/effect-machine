import { assert, describe, it } from "@effect/vitest"
import {
  Cause,
  Clock,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Latch,
  Layer,
  Option,
  Schema,
  SchemaGetter,
  SchemaIssue,
  Stream,
  Tracer
} from "effect"
import { MessageStorage, RunnerStorage, Sharding, Snowflake } from "effect/cluster"
import { TestClock } from "effect/testing"
import { LocalMachine, Machine } from "../../../src/index.js"
import { ClusterMachine } from "../../../src/unstable/cluster/index.js"
import {
  adapt,
  makeLayer,
  makeMessages,
  makeTestStorage,
  startRunner,
  storageKey,
  type TestStorage
} from "./support/harness.js"
class Count extends Schema.TaggedClass<Count>("Count")("Count", {
  value: Schema.NumberFromString
}) {}
class Done extends Schema.TaggedClass<Done>("Done")("Done", {
  value: Schema.NumberFromString
}) {}
class Increment extends Schema.TaggedClass<Increment>("Increment")("Increment", {
  by: Schema.Number,
  block: Schema.Boolean
}) {}
class Fail extends Schema.TaggedClass<Fail>("Fail")("Fail", {}) {}
class Finish extends Schema.TaggedClass<Finish>("Finish")("Finish", {}) {}
class RaiseFromAction extends Schema.TaggedClass<RaiseFromAction>("RaiseFromAction")("RaiseFromAction", {}) {}
class SpawnFromAction extends Schema.TaggedClass<SpawnFromAction>("SpawnFromAction")("SpawnFromAction", {}) {}
class Changed extends Schema.TaggedClass<Changed>("Changed")("Changed", {
  value: Schema.Number
}) {}
const CounterStates = Machine.state({
  states: {
    Count,
    Done: { schema: Done, type: "final" }
  }
})
const InitialRoot1 = Machine.state({ states: { Count } })
const UnsupportedChildMachine = Machine.make({
  root: InitialRoot1,
  events: Machine.eventsFromSchemas()
}).handle({
  initial: {
    target: "Count",
    decoded: true,
    data: new Count({ value: 0 })
  },
  states: {
    Count: {}
  }
})
const UnsupportedChild = Machine.child("unsupported", UnsupportedChildMachine)
const UnsupportedChildAddress = Machine.childAddress("unsupported")
const makeCounter = (state: {
  readonly gate: Latch.Latch
  initialEntries: number
  actions: number
  inFlight: number
  maxInFlight: number
}) => {
  return Machine.make({
    id: "Counter",
    root: CounterStates,
    events: Machine.eventsFromSchemas(Increment, Fail, Finish, RaiseFromAction, SpawnFromAction),
    emittedEvents: Machine.emittedEventsFromSchemas(Changed)
  }).handle({
    initial: {
      target: "Count",
      decoded: true,
      data: new Count({ value: 0 })
    },
    states: {
      Count: {
        entry: () => {
          state.initialEntries += 1
        },
        on: {
          Increment: {
            branches: [{ target: "Count" }],
            resolve: ({ event, state: current, select }, enqueue) => {
              state.actions += 1
              state.inFlight += 1
              state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
              state.inFlight -= 1
              const value = current.value + event.by
              enqueue.emit(new Changed({ value }))
              return select.target("Count", { data: new Count({ value }), decoded: true })
            }
          },
          Fail: {
            branches: [{ target: "Count" }],
            resolve: ({ state: current, select }, enqueue) => {
              enqueue.emit(new Changed({ value: 999 }))
              return select.target("Count", { data: current, decoded: true })
            }
          },
          Finish: {
            target: "Done",
            decoded: true,
            data: ({ state: current }) => (new Done({ value: current.value }))
          },
          RaiseFromAction: {
            branches: [{ target: "Count" }],
            resolve: ({ state: current, select }, enqueue) => {
              enqueue.raise(new Increment({ by: 1, block: false }))
              return select.target("Count", { data: current, decoded: true })
            }
          },
          SpawnFromAction: {
            branches: [{ target: "Count" }],
            resolve: ({ state: current, select }, enqueue) => {
              enqueue.stop(UnsupportedChildAddress)
              return select.target("Count", { data: current, decoded: true })
            }
          }
        }
      },
      Done: {}
    }
  })
}
const request = (requestId: Snowflake.Snowflake): ClusterMachine.Checkpoint.Origin => ({ _tag: "Request", requestId })
const active: ClusterMachine.Checkpoint.Status = { _tag: "Active", invocations: {} }
const countOf = (storage: TestStorage, key: string) => {
  const stored = storage.entries.get(key)
  return stored && {
    revision: stored.revision,
    value: stored.snapshot.active.find(({ path }) => path === "Count")?.value
  }
}
const encodedCount = (value: number) => ({ _tag: "Count", value: String(value) })
const withCount = (value: number) => (checkpoint: ClusterMachine.Checkpoint): ClusterMachine.Checkpoint => ({
  ...checkpoint,
  snapshot: {
    ...checkpoint.snapshot,
    active: [{ path: "" }, { path: "Count", value: encodedCount(value) }]
  }
})
const increment = (by = 1) => new Increment({ by, block: false })
const makeState = Effect.map(
  Latch.make(),
  (gate) => ({ gate, initialEntries: 0, actions: 0, inFlight: 0, maxInFlight: 0 })
)
/** A transaction that rolls the test storage back when it fails. */
const rollingBack = (
  storage: TestStorage,
  emitted: Array<unknown>
): MessageStorage.MessageStorage["Service"]["withTransaction"] =>
(effect) =>
  Effect.suspend(() => {
    const checkpoint = storage.snapshot()
    const emittedLength = emitted.length
    return Effect.onExit(Effect.provideService(effect, MessageStorage.MemoryTransaction, true), (exit) =>
      Exit.isFailure(exit)
        ? Effect.sync(() => {
          storage.restore(checkpoint)
          emitted.length = emittedLength
        })
        : Effect.void)
  })
/** Ids of the stored requests, in the order they were first sent. */
const sentRequestIds = Effect.map(
  MessageStorage.MemoryDriver,
  (driver) =>
    driver.journal.flatMap((envelope) => envelope._tag === "Request" ? [Snowflake.Snowflake(envelope.requestId)] : [])
)
/** The tag and reason of the reply stored for a request, once there is one. */
const awaitReply = Effect.fnUntraced(function*(requestId: Snowflake.Snowflake) {
  const driver = yield* MessageStorage.MemoryDriver
  const replies = () => driver.requests.get(String(requestId))!.replies
  yield* Effect.yieldNow.pipe(Effect.repeat({ until: () => replies().length > 0 }))
  const reply = replies()[0]!
  assert(reply._tag === "WithExit" && reply.exit._tag === "Success")
  return reply.exit.value as { readonly _tag: string; readonly reason?: string }
})
/** Drops the stored reply of a request, so Cluster delivers it to the live entity again. */
const redeliver = Effect.fnUntraced(function*(requestId: Snowflake.Snowflake) {
  const sharding = yield* Sharding.Sharding
  assert.isTrue(yield* sharding.reset(requestId))
  yield* sharding.pollStorage
  yield* TestClock.adjust(1)
  const reply = yield* awaitReply(requestId)
  assert.strictEqual(yield* sharding.activeEntityCount, 1)
  return reply
})
const assertAccepted = (result: ClusterMachine.Accepted | ClusterMachine.Rejected) => {
  assert.instanceOf(result, ClusterMachine.Accepted)
}
const assertRejected = (
  result: ClusterMachine.Accepted | ClusterMachine.Rejected,
  reason: ClusterMachine.RejectionReason
) => {
  assert.instanceOf(result, ClusterMachine.Rejected)
  assert.strictEqual(result.reason, reason)
}
describe("ClusterMachine", () => {
  it.effect("initializes, persists transformed state, and restores after passivation", () =>
    Effect.gen(function*() {
      const gate = yield* Latch.make()
      const state = { gate, initialEntries: 0, actions: 0, inFlight: 0, maxInFlight: 0 }
      const machine = makeCounter(state)
      const bridge = ClusterMachine.make("CounterEntity", machine, { version: "1" })
      const storage = makeTestStorage()
      const emitted: Array<Changed> = []
      const emissionTransactions: Array<boolean> = []
      const layer = makeLayer(bridge, storage.service, (event) =>
        MessageStorage.MemoryTransaction.use((inTransaction) =>
          Effect.sync(() => {
            emissionTransactions.push(inTransaction)
            emitted.push(event)
          })
        ), 0)
      yield* Effect.gen(function*() {
        yield* TestClock.adjust(1)
        const makeClient = yield* bridge.entity.client
        const client = makeClient("counter-1")
        assertAccepted(yield* client.send(new Increment({ by: 2, block: false })))
        assert.strictEqual(state.initialEntries, 1)
        assert.strictEqual(state.actions, 1)
        assert.deepStrictEqual(emitted, [new Changed({ value: 2 })])
        assert.deepStrictEqual(storage.entries.get(storageKey("CounterEntity", "counter-1"))?.snapshot, {
          version: 2,
          _tag: "MachineSnapshot",
          active: [{ path: "" }, { path: "Count" as const, value: { _tag: "Count", value: "2" } }]
        })
        yield* TestClock.adjust(5000)
        yield* Effect.yieldNow
        assert.strictEqual(
          yield* Sharding.Sharding.pipe(Effect.flatMap((sharding) =>
            sharding.activeEntityCount
          )),
          0
        )
        assertAccepted(yield* client.send(new Increment({ by: 3, block: false })))
        assert.strictEqual(state.initialEntries, 1)
        assert.strictEqual(state.actions, 2)
        assert.deepStrictEqual(storage.entries.get(storageKey("CounterEntity", "counter-1"))?.snapshot.active, [{
          path: ""
        }, {
          path: "Count" as const,
          value: { _tag: "Count", value: "5" }
        }])
        assert.isTrue(storage.transactionFlags.every(Boolean))
        assert.isTrue(emissionTransactions.every(Boolean))
      }).pipe(Effect.provide(layer))
    }))
  it.effect("serializes events for one entity", () =>
    Effect.gen(function*() {
      const gate = yield* Latch.make()
      const state = { gate, initialEntries: 0, actions: 0, inFlight: 0, maxInFlight: 0 }
      const bridge = ClusterMachine.make("SerializedCounter", makeCounter(state), { version: "1" })
      const storage = makeTestStorage()
      yield* Effect.gen(function*() {
        yield* TestClock.adjust(1)
        const makeClient = yield* bridge.entity.client
        const client = makeClient("counter-1")
        const first = yield* client.send(new Increment({ by: 1, block: true })).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.yieldNow
        const second = yield* client.send(new Increment({ by: 1, block: false })).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.yieldNow
        assertAccepted(yield* Fiber.join(first))
        assertAccepted(yield* Fiber.join(second))
        assert.strictEqual(state.maxInFlight, 1)
        assert.strictEqual(state.actions, 2)
        assert.deepStrictEqual(storage.entries.get(storageKey("SerializedCounter", "counter-1"))?.snapshot.active, [{
          path: ""
        }, {
          path: "Count" as const,
          value: { _tag: "Count", value: "2" }
        }])
      }).pipe(Effect.provide(makeLayer(bridge, storage.service, () => Effect.void)))
    }))
  it.effect("suppresses emissions when checkpoint persistence fails", () =>
    Effect.gen(function*() {
      const gate = yield* Latch.make()
      const state = { gate, initialEntries: 0, actions: 0, inFlight: 0, maxInFlight: 0 }
      const bridge = ClusterMachine.make("PersistenceFailureCounter", makeCounter(state), { version: "1" })
      const storage = makeTestStorage()
      const emitted: Array<Changed> = []
      storage.failNextCommit()
      yield* Effect.gen(function*() {
        yield* TestClock.adjust(1)
        const makeClient = yield* bridge.entity.client
        const client = makeClient("counter-1")
        assertRejected(yield* client.send(new Increment({ by: 1, block: false })), "PersistenceFailure")
        assert.strictEqual(storage.entries.size, 0)
        assert.strictEqual(storage.commits, 0)
        assert.deepStrictEqual(emitted, [])
        assertAccepted(yield* client.send(new Increment({ by: 1, block: false })))
        assert.strictEqual(storage.commits, 1)
        assert.deepStrictEqual(emitted, [new Changed({ value: 1 })])
      }).pipe(Effect.provide(makeLayer(bridge, storage.service, (event) => Effect.sync(() => emitted.push(event)))))
    }))
  it.effect("rejects snapshot encoding failures before persistence", () =>
    Effect.gen(function*() {
      interface OpaqueState {
        readonly _tag: "OpaqueState"
        readonly resource: object
      }
      const OpaqueState = Schema.toCodecJson(Schema.declare<OpaqueState>((value): value is OpaqueState =>
        typeof value === "object" && value !== null && "_tag" in value && value._tag === "OpaqueState"
      ))
      const opaqueStates = Machine.state({ states: { OpaqueState } })
      const resource: {
        self?: unknown
      } = {}
      resource.self = resource
      const opaqueMachine = Machine.make({
        root: opaqueStates,
        events: Machine.eventsFromSchemas(Fail)
      }).handle({
        initial: {
          target: "OpaqueState",
          decoded: true,
          data: { _tag: "OpaqueState", resource }
        },
        states: {
          OpaqueState: {
            on: {
              Fail: {
                target: "OpaqueState",
                decoded: true,
                data: ({ state: current }) =>
                  current
              }
            }
          }
        }
      })
      const bridge = ClusterMachine.make("SnapshotEncodeFailureEntity", opaqueMachine, { version: "1" })
      const storage = makeTestStorage()
      yield* Effect.gen(function*() {
        yield* TestClock.adjust(1)
        const makeClient = yield* bridge.entity.client
        const result = yield* makeClient("opaque-1").send(new Fail({}))
        assertRejected(result, "SnapshotEncodeFailure")
        assert.strictEqual(storage.entries.size, 0)
        assert.strictEqual(storage.commits, 0)
      }).pipe(Effect.provide(makeLayer(bridge, storage.service, () => Effect.void)))
    }))
  it.effect("does not apply a redelivered persisted request twice", () =>
    Effect.gen(function*() {
      const gate = yield* Latch.make()
      const state = { gate, initialEntries: 0, actions: 0, inFlight: 0, maxInFlight: 0 }
      const bridge = ClusterMachine.make("DeduplicatedCounter", makeCounter(state), { version: "1" })
      const storage = makeTestStorage()
      yield* Effect.gen(function*() {
        yield* TestClock.adjust(1)
        const sharding = yield* Sharding.Sharding
        const driver = yield* MessageStorage.MemoryDriver
        const makeClient = yield* bridge.entity.client
        const client = makeClient("counter-1")
        assertAccepted(yield* client.send(new Increment({ by: 1, block: false })))
        const requestId = Snowflake.Snowflake(driver.journal[0]!.requestId)
        const key = storageKey("DeduplicatedCounter", "counter-1")
        storage.entries.set(key, {
          ...storage.entries.get(key)!,
          version: "previous-deployment"
        })
        assert.isTrue(yield* sharding.reset(requestId))
        yield* sharding.pollStorage
        yield* TestClock.adjust(1)
        yield* Effect.yieldNow.pipe(Effect.repeat({ until: () => storage.commitAttempts >= 2 }))
        yield* Effect.yieldNow.pipe(
          Effect.repeat({ until: () => driver.requests.get(String(requestId))!.replies.length > 0 })
        )
        assert.strictEqual(storage.loads, 1)
        // Planned again from memory, then discarded because the commit reports a duplicate.
        assert.strictEqual(state.actions, 2)
        assert.strictEqual(storage.commits, 1)
        assert.deepStrictEqual(storage.entries.get(key)?.snapshot.active, [{ path: "" }, {
          path: "Count" as const,
          value: { _tag: "Count", value: "1" }
        }])
        const reply = driver.requests.get(String(requestId))!.replies[0]!
        assert(
          reply._tag === "WithExit" && reply.exit._tag === "Success" &&
            (reply.exit.value as {
                readonly _tag: string
              })._tag === "Accepted"
        )
      }).pipe(Effect.provide(makeLayer(bridge, storage.service, () => Effect.void)))
    }))
  it.effect("rolls back a checkpoint and partial outbox when enqueue fails", () =>
    Effect.gen(function*() {
      const gate = yield* Latch.make()
      const state = { gate, initialEntries: 0, actions: 0, inFlight: 0, maxInFlight: 0 }
      const bridge = ClusterMachine.make("EmissionFailureCounter", makeCounter(state), { version: "1" })
      const storage = makeTestStorage()
      const emitted: Array<Changed> = []
      const withTransaction: MessageStorage.MessageStorage["Service"]["withTransaction"] = (effect) => {
        const checkpoint = storage.snapshot()
        const emittedLength = emitted.length
        return Effect.onExit(Effect.provideService(effect, MessageStorage.MemoryTransaction, true), (exit) =>
          Exit.isFailure(exit)
            ? Effect.sync(() => {
              storage.restore(checkpoint)
              emitted.length = emittedLength
            })
            : Effect.void)
      }
      yield* Effect.gen(function*() {
        yield* TestClock.adjust(1)
        const makeClient = yield* bridge.entity.client
        const result = yield* makeClient("counter-1").send(new Increment({ by: 1, block: false }))
        assertRejected(result, "EmissionFailure")
        assert.strictEqual(storage.entries.size, 0)
        assert.strictEqual(storage.commits, 0)
        assert.deepStrictEqual(emitted, [])
      }).pipe(Effect.provide(makeLayer(
        bridge,
        storage.service,
        (event) =>
          Effect.sync(() =>
            emitted.push(event)
          ).pipe(Effect.andThen(Effect.fail("outbox unavailable"))),
        undefined,
        { withTransaction }
      )))
    }))
  it.effect("keeps historical request ids in the in-memory storage", () =>
    Effect.gen(function*() {
      const storage = yield* ClusterMachine.Storage
      const address = {
        entityType: "MemoryCounter",
        entityId: "counter-1",
        shardId: { group: "default", id: 1 }
      } as any
      const firstId = Snowflake.Snowflake(1)
      const secondId = Snowflake.Snowflake(2)
      const first: ClusterMachine.Checkpoint = {
        definitionId: "Counter",
        version: "1",
        revision: 1,
        origin: request(firstId),
        status: active,
        snapshot: {
          version: 2,
          _tag: "MachineSnapshot",
          active: [{ path: "" }, { path: "Count" as const, value: { _tag: "Count", value: "1" } }]
        }
      }
      const second: ClusterMachine.Checkpoint = {
        ...first,
        revision: 2,
        origin: request(secondId),
        snapshot: {
          version: 2,
          _tag: "MachineSnapshot",
          active: [{ path: "" }, { path: "Count" as const, value: { _tag: "Count", value: "2" } }]
        }
      }
      assert.deepStrictEqual(yield* storage.commit(address, first), ClusterMachine.CommitResult.Committed())
      assert.deepStrictEqual(yield* storage.commit(address, second), ClusterMachine.CommitResult.Committed())
      assert.deepStrictEqual(yield* storage.commit(address, first), ClusterMachine.CommitResult.Duplicate())
      const loaded = yield* storage.loadForRequest(address, firstId)
      assert.isTrue(loaded.processed)
      assert.deepStrictEqual(Option.getOrThrow(loaded.checkpoint), second)
    }).pipe(Effect.provide(ClusterMachine.layerMemory)))
  it.effect("rejects incompatible and undecodable checkpoints without resetting", () =>
    Effect.gen(function*() {
      const cases: ReadonlyArray<{
        readonly entityType: string
        readonly definitionId: string
        readonly version: string
        readonly snapshot: Machine.Machine.EncodedSnapshot
        readonly reason: ClusterMachine.RejectionReason
      }> = [
        {
          entityType: "WrongMachineCounter",
          definitionId: "Other",
          version: "1",
          snapshot: {
            version: 2,
            _tag: "MachineSnapshot",
            active: [{ path: "" }, { path: "Count" as const, value: { _tag: "Count", value: "0" } }]
          },
          reason: "DefinitionIdMismatch"
        },
        {
          entityType: "WrongVersionCounter",
          definitionId: "Counter",
          version: "0",
          snapshot: {
            version: 2,
            _tag: "MachineSnapshot",
            active: [{ path: "" }, { path: "Count" as const, value: { _tag: "Count", value: "0" } }]
          },
          reason: "VersionMismatch"
        },
        {
          entityType: "InvalidSnapshotCounter",
          definitionId: "Counter",
          version: "1",
          snapshot: {
            version: 2,
            _tag: "MachineSnapshot",
            active: [{ path: "" }, { path: "Missing" as const, value: {} }]
          },
          reason: "InvalidCheckpoint"
        }
      ]
      for (const testCase of cases) {
        const gate = yield* Latch.make()
        const state = { gate, initialEntries: 0, actions: 0, inFlight: 0, maxInFlight: 0 }
        const bridge = ClusterMachine.make(testCase.entityType, makeCounter(state), { version: "1" })
        const storage = makeTestStorage()
        const checkpoint = {
          definitionId: testCase.definitionId,
          version: testCase.version,
          revision: 1,
          origin: request(Snowflake.Snowflake(0)),
          status: active,
          snapshot: testCase.snapshot
        }
        storage.entries.set(storageKey(testCase.entityType, "counter-1"), checkpoint)
        yield* Effect.gen(function*() {
          yield* TestClock.adjust(1)
          const makeClient = yield* bridge.entity.client
          assertRejected(yield* makeClient("counter-1").send(new Increment({ by: 1, block: false })), testCase.reason)
          assert.strictEqual(storage.entries.get(storageKey(testCase.entityType, "counter-1")), checkpoint)
          assert.strictEqual(storage.commits, 0)
          assert.strictEqual(state.initialEntries, 0)
        }).pipe(Effect.provide(makeLayer(bridge, storage.service, () => Effect.void)))
      }
    }))
  it.effect("persists final state and treats later events as no-ops", () =>
    Effect.gen(function*() {
      const gate = yield* Latch.make()
      const state = { gate, initialEntries: 0, actions: 0, inFlight: 0, maxInFlight: 0 }
      const bridge = ClusterMachine.make("FinalCounter", makeCounter(state), { version: "1" })
      const storage = makeTestStorage()
      yield* Effect.gen(function*() {
        yield* TestClock.adjust(1)
        const makeClient = yield* bridge.entity.client
        const client = makeClient("counter-1")
        assertAccepted(yield* client.send(new Finish({})))
        assert.deepStrictEqual(storage.entries.get(storageKey("FinalCounter", "counter-1"))?.snapshot.active, [{
          path: ""
        }, {
          path: "Done" as const,
          value: { _tag: "Done", value: "0" }
        }])
        assertAccepted(yield* client.send(new Increment({ by: 10, block: false })))
        assert.strictEqual(state.actions, 0)
        assert.strictEqual(storage.commits, 2)
        assert.deepStrictEqual(storage.entries.get(storageKey("FinalCounter", "counter-1"))?.snapshot.active, [{
          path: ""
        }, {
          path: "Done" as const,
          value: { _tag: "Done", value: "0" }
        }])
      }).pipe(Effect.provide(makeLayer(bridge, storage.service, () => Effect.void)))
    }))
  it.effect("rejects process-local machine commands", () =>
    Effect.gen(function*() {
      const gate = yield* Latch.make()
      const state = { gate, initialEntries: 0, actions: 0, inFlight: 0, maxInFlight: 0 }
      const bridge = ClusterMachine.make("UnsupportedCommand", makeCounter(state), { version: "1" })
      const storage = makeTestStorage()
      yield* Effect.gen(function*() {
        yield* TestClock.adjust(1)
        const makeClient = yield* bridge.entity.client
        assertRejected(yield* makeClient("counter-1").send(new SpawnFromAction({})), "UnsupportedProcessLocal")
        assert.strictEqual(storage.commits, 0)
      }).pipe(Effect.provide(makeLayer(bridge, storage.service, () => Effect.void)))
    }))
  describe("refused invocations", () => {
    const Source = Machine.logic({ initial: 0, run: () => Effect.never })
    const Idle = Machine.state({ states: { Count, Other: {} } })
    const base = {
      id: "Invoked",
      root: Idle,
      events: Machine.eventsFromSchemas(Increment),
      effects: { work: Effect.never },
      timers: { wait: "1 second" as const },
      streams: { numbers: Stream.make(1) },
      logic: { process: Source },
      children: { child: UnsupportedChild }
    }
    const initial = { target: "Count", decoded: true, data: new Count({ value: 0 }) } as const
    const machines = {
      Stream: () =>
        Machine.make(base).handle({
          initial,
          states: {
            Count: {},
            Other: { invoke: { src: "numbers", onElement: { stay: true }, onDone: { stay: true } } }
          }
        }),
      Logic: () =>
        Machine.make(base).handle({
          initial,
          states: {
            Count: {},
            Other: { invoke: { src: "process", id: "process", address: Machine.childAddress("process") } }
          }
        })
    }
    for (const kind of ["Stream", "Logic"] as const) {
      it.effect(`rejects every request to a machine that invokes a ${kind}, in whatever state`, () =>
        Effect.gen(function*() {
          const bridge = adapt(`Invoked${kind}`, machines[kind]())
          const storage = makeTestStorage()
          yield* Effect.gen(function*() {
            yield* TestClock.adjust(1)
            const client = (yield* bridge.entity.client)("counter-1")
            const rejected = yield* client.send(increment())
            assertRejected(rejected, "UnsupportedProcessLocal")
            assert.instanceOf(rejected, ClusterMachine.Rejected)
            assert.match(rejected.message, new RegExp(`^${kind} invocation ".*" of state "Other"`))
            assert.strictEqual(storage.commitAttempts, 0)
            // Only the question whether the request was committed before.
            assert.strictEqual(storage.loads, 1)
          }).pipe(Effect.provide(makeLayer(bridge, storage.service)))
        }))
    }
    it.effect("starts no work of a machine that mixes an effect with a refused invocation", () =>
      Effect.gen(function*() {
        let runs = 0
        const machine = Machine.make({
          ...base,
          effects: {
            work: Effect.suspend(() => {
              runs += 1
              return Effect.never
            })
          }
        }).handle({
          initial,
          states: {
            Count: { invoke: { src: "work" } },
            Other: { invoke: { src: "numbers", onElement: { stay: true }, onDone: { stay: true } } }
          }
        })
        const bridge = adapt("MixedInvocations", machine)
        const storage = makeTestStorage()
        yield* Effect.gen(function*() {
          yield* TestClock.adjust(1)
          const client = (yield* bridge.entity.client)("counter-1")
          assertRejected(yield* client.send(increment()), "UnsupportedProcessLocal")
          assert.strictEqual(runs, 0)
          assert.strictEqual(storage.commitAttempts, 0)
        }).pipe(Effect.provide(makeLayer(bridge, storage.service)))
      }))
  })

  describe("live instance", () => {
    it.effect("loads the checkpoint once for many requests", () =>
      Effect.gen(function*() {
        const state = yield* makeState
        const bridge = ClusterMachine.make("LiveCounter", makeCounter(state), { version: "1" })
        const storage = makeTestStorage()
        yield* Effect.gen(function*() {
          yield* TestClock.adjust(1)
          const makeClient = yield* bridge.entity.client
          const client = makeClient("counter-1")
          for (let i = 0; i < 5; i++) {
            assertAccepted(yield* client.send(increment()))
          }
          assert.strictEqual(storage.loads, 1)
          assert.strictEqual(storage.commits, 5)
          assert.strictEqual(state.initialEntries, 1)
          assert.deepStrictEqual(countOf(storage, storageKey("LiveCounter", "counter-1")), {
            revision: 5,
            value: encodedCount(5)
          })
          // Another entity has its own instance.
          assertAccepted(yield* makeClient("counter-2").send(increment()))
          assert.strictEqual(storage.loads, 2)
          assert.deepStrictEqual(countOf(storage, storageKey("LiveCounter", "counter-2")), {
            revision: 1,
            value: encodedCount(1)
          })
        }).pipe(Effect.provide(makeLayer(bridge, storage.service, () => Effect.void)))
      }))
    it.effect("loads again after passivation and continues from the stored state", () =>
      Effect.gen(function*() {
        const state = yield* makeState
        const bridge = ClusterMachine.make("PassivatedCounter", makeCounter(state), { version: "1" })
        const storage = makeTestStorage()
        const key = storageKey("PassivatedCounter", "counter-1")
        yield* Effect.gen(function*() {
          yield* TestClock.adjust(1)
          const sharding = yield* Sharding.Sharding
          const client = (yield* bridge.entity.client)("counter-1")
          assertAccepted(yield* client.send(increment()))
          assertAccepted(yield* client.send(increment()))
          assert.strictEqual(storage.loads, 1)
          yield* TestClock.adjust(5000)
          yield* Effect.yieldNow
          assert.strictEqual(yield* sharding.activeEntityCount, 0)
          storage.write(key, withCount(10))
          assertAccepted(yield* client.send(increment()))
          assert.strictEqual(storage.loads, 2)
          assert.strictEqual(storage.commits, 3)
          assert.strictEqual(state.initialEntries, 1)
          assert.deepStrictEqual(countOf(storage, key), { revision: 4, value: encodedCount(11) })
        }).pipe(Effect.provide(makeLayer(bridge, storage.service, () => Effect.void, 0)))
      }))
    it.effect("applies concurrent requests one at a time from memory", () =>
      Effect.gen(function*() {
        const state = yield* makeState
        const bridge = ClusterMachine.make("ConcurrentCounter", makeCounter(state), { version: "1" })
        const storage = makeTestStorage()
        const emitted: Array<unknown> = []
        let blocked = true
        const layer = makeLayer(bridge, storage.service, (event) =>
          Effect.suspend(() => {
            emitted.push(event)
            return blocked ? state.gate.await : Effect.void
          }))
        yield* Effect.gen(function*() {
          yield* TestClock.adjust(1)
          const client = (yield* bridge.entity.client)("counter-1")
          const first = yield* client.send(increment()).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Effect.yieldNow.pipe(Effect.repeat({ until: () => emitted.length === 1 }))
          const second = yield* client.send(increment()).pipe(Effect.forkChild({ startImmediately: true }))
          yield* TestClock.adjust(1)
          assert.strictEqual(state.actions, 1)
          blocked = false
          yield* state.gate.open
          assertAccepted(yield* Fiber.join(first))
          assertAccepted(yield* Fiber.join(second))
          assert.strictEqual(storage.loads, 1)
          assert.strictEqual(storage.commits, 2)
          assert.deepStrictEqual(emitted, [new Changed({ value: 1 }), new Changed({ value: 2 })])
        }).pipe(Effect.provide(layer))
      }))
    it.effect("does not cache a failed load or an incompatible checkpoint", () =>
      Effect.gen(function*() {
        const state = yield* makeState
        const bridge = ClusterMachine.make("UncachedCounter", makeCounter(state), { version: "1" })
        const storage = makeTestStorage()
        const key = storageKey("UncachedCounter", "counter-1")
        const stored: ClusterMachine.Checkpoint = {
          definitionId: "Counter",
          version: "1",
          revision: 4,
          origin: request(Snowflake.Snowflake(0)),
          status: active,
          snapshot: { version: 2, _tag: "MachineSnapshot", active: [] }
        }
        const valid = withCount(5)(stored)
        yield* Effect.gen(function*() {
          yield* TestClock.adjust(1)
          const client = (yield* bridge.entity.client)("counter-1")
          storage.failNextLoad()
          assertRejected(yield* client.send(increment()), "PersistenceFailure")
          assert.strictEqual(storage.loads, 1)
          const incompatible: ReadonlyArray<[ClusterMachine.Checkpoint, ClusterMachine.RejectionReason]> = [
            [{ ...valid, definitionId: "Other" }, "DefinitionIdMismatch"],
            [{ ...valid, version: "0" }, "VersionMismatch"],
            [stored, "InvalidCheckpoint"],
            [{ ...valid, revision: 0 }, "InvalidCheckpoint"],
            // A checkpoint that was stored before revisions existed.
            [{ ...valid, revision: undefined as never }, "InvalidCheckpoint"]
          ]
          for (const [checkpoint, reason] of incompatible) {
            storage.entries.set(key, checkpoint)
            const loads = storage.loads
            assertRejected(yield* client.send(increment()), reason)
            assertRejected(yield* client.send(increment()), reason)
            assert.strictEqual(storage.loads, loads + 2)
          }
          assert.strictEqual(storage.commitAttempts, 0)
          storage.entries.set(key, valid)
          assertAccepted(yield* client.send(increment()))
          assert.deepStrictEqual(countOf(storage, key), { revision: 5, value: encodedCount(6) })
          const loads = storage.loads
          assertAccepted(yield* client.send(increment()))
          assert.strictEqual(storage.loads, loads)
        }).pipe(Effect.provide(makeLayer(bridge, storage.service, () => Effect.void)))
      }))
    it.effect("loads again after a commit fails", () =>
      Effect.gen(function*() {
        const state = yield* makeState
        const bridge = ClusterMachine.make("CommitFailureCounter", makeCounter(state), { version: "1" })
        const storage = makeTestStorage()
        const key = storageKey("CommitFailureCounter", "counter-1")
        const emitted: Array<unknown> = []
        yield* Effect.gen(function*() {
          yield* TestClock.adjust(1)
          const client = (yield* bridge.entity.client)("counter-1")
          assertAccepted(yield* client.send(increment()))
          storage.failNextCommit()
          assertRejected(yield* client.send(increment(100)), "PersistenceFailure")
          // The second load asked whether the request had been committed before.
          assert.strictEqual(storage.loads, 2)
          assert.strictEqual(storage.commits, 1)
          assertAccepted(yield* client.send(increment()))
          assert.strictEqual(storage.loads, 3)
          assert.strictEqual(storage.commits, 2)
          assert.deepStrictEqual(countOf(storage, key), { revision: 2, value: encodedCount(2) })
          assert.deepStrictEqual(emitted, [new Changed({ value: 1 }), new Changed({ value: 2 })])
        }).pipe(Effect.provide(makeLayer(bridge, storage.service, (event) =>
          Effect.sync(() => {
            emitted.push(event)
          }))))
      }))
    for (const rollsBack of [true, false]) {
      it.effect(`loads again after an emission fails in a store that ${rollsBack ? "rolls" : "does not roll"} back`, () =>
        Effect.gen(function*() {
          const state = yield* makeState
          const type = rollsBack ? "RolledBackEmission" : "KeptEmission"
          const bridge = ClusterMachine.make(type, makeCounter(state), { version: "1" })
          const storage = makeTestStorage()
          const key = storageKey(type, "counter-1")
          const emitted: Array<unknown> = []
          let failNext = false
          const layer = makeLayer(
            bridge,
            storage.service,
            (event) =>
              Effect.suspend(() => {
                emitted.push(event)
                if (!failNext) return Effect.void
                failNext = false
                return Effect.fail("outbox unavailable")
              }),
            undefined,
            rollsBack ? { withTransaction: rollingBack(storage, emitted) } : undefined
          )
          yield* Effect.gen(function*() {
            yield* TestClock.adjust(1)
            const client = (yield* bridge.entity.client)("counter-1")
            assertAccepted(yield* client.send(increment()))
            failNext = true
            assertRejected(yield* client.send(increment(10)), "EmissionFailure")
            assert.strictEqual(storage.loads, 1)
            assert.strictEqual(storage.commits, rollsBack ? 1 : 2)
            assertAccepted(yield* client.send(increment()))
            assert.strictEqual(storage.loads, 2)
            assert.deepStrictEqual(
              countOf(storage, key),
              rollsBack ? { revision: 2, value: encodedCount(2) } : { revision: 3, value: encodedCount(12) }
            )
            assert.deepStrictEqual(
              emitted,
              rollsBack
                ? [new Changed({ value: 1 }), new Changed({ value: 2 })]
                : [new Changed({ value: 1 }), new Changed({ value: 11 }), new Changed({ value: 12 })]
            )
          }).pipe(Effect.provide(layer))
        }))
    }
    it.effect("loads again after a defect while enqueueing", () =>
      Effect.gen(function*() {
        const state = yield* makeState
        const bridge = ClusterMachine.make("DefectCounter", makeCounter(state), { version: "1" })
        const storage = makeTestStorage()
        const key = storageKey("DefectCounter", "counter-1")
        let dieNext = false
        const layer = makeLayer(bridge, storage.service, () =>
          Effect.sync(() => {
            if (!dieNext) return
            dieNext = false
            throw new Error("boom")
          }))
        yield* Effect.gen(function*() {
          yield* TestClock.adjust(1)
          const client = (yield* bridge.entity.client)("counter-1")
          assertAccepted(yield* client.send(increment()))
          dieNext = true
          assertRejected(yield* client.send(increment()), "TransitionFailure")
          assertAccepted(yield* client.send(increment()))
          assert.strictEqual(storage.loads, 2)
          assert.deepStrictEqual(countOf(storage, key), { revision: 3, value: encodedCount(3) })
        }).pipe(Effect.provide(layer))
      }))
    it.effect("does not advance memory when the transaction fails after the step", () =>
      Effect.gen(function*() {
        const state = yield* makeState
        const bridge = ClusterMachine.make("TransactionFailureCounter", makeCounter(state), { version: "1" })
        const storage = makeTestStorage()
        const key = storageKey("TransactionFailureCounter", "counter-1")
        const emitted: Array<unknown> = []
        let failNext = false
        const transaction = rollingBack(storage, emitted)
        const withTransaction: typeof transaction = (effect) =>
          transaction(Effect.tap(effect, () =>
            Effect.sync(() => {
              if (!failNext) return
              failNext = false
              throw new Error("commit unavailable")
            })))
        yield* Effect.gen(function*() {
          yield* TestClock.adjust(1)
          const client = (yield* bridge.entity.client)("counter-1")
          assertAccepted(yield* client.send(increment()))
          failNext = true
          assertRejected(yield* client.send(increment(10)), "PersistenceFailure")
          assert.strictEqual(storage.loads, 2)
          assert.strictEqual(storage.commits, 1)
          assertAccepted(yield* client.send(increment()))
          assert.strictEqual(storage.loads, 3)
          assert.deepStrictEqual(countOf(storage, key), { revision: 2, value: encodedCount(2) })
          assert.deepStrictEqual(emitted, [new Changed({ value: 1 }), new Changed({ value: 2 })])
        }).pipe(Effect.provide(makeLayer(
          bridge,
          storage.service,
          (event) =>
            Effect.sync(() => {
              emitted.push(event)
            }),
          undefined,
          { withTransaction }
        )))
      }))
    it.effect("accepts a request whose transaction took effect although it reported a failure", () =>
      Effect.gen(function*() {
        const state = yield* makeState
        const bridge = ClusterMachine.make("LostAcknowledgement", makeCounter(state), { version: "1" })
        const storage = makeTestStorage()
        const key = storageKey("LostAcknowledgement", "counter-1")
        let failNext = false
        const withTransaction: MessageStorage.MessageStorage["Service"]["withTransaction"] = (effect) =>
          Effect.tap(Effect.provideService(effect, MessageStorage.MemoryTransaction, true), () =>
            Effect.sync(() => {
              if (!failNext) return
              failNext = false
              throw new Error("acknowledgement lost")
            }))
        yield* Effect.gen(function*() {
          yield* TestClock.adjust(1)
          const client = (yield* bridge.entity.client)("counter-1")
          assertAccepted(yield* client.send(increment()))
          failNext = true
          assertAccepted(yield* client.send(increment()))
          assertAccepted(yield* client.send(increment()))
          assert.strictEqual(storage.loads, 3)
          assert.deepStrictEqual(countOf(storage, key), { revision: 3, value: encodedCount(3) })
        }).pipe(Effect.provide(makeLayer(bridge, storage.service, () => Effect.void, undefined, { withTransaction })))
      }))
  })
  describe("stale instance", () => {
    it.effect("applies a request to the state another instance stored", () =>
      Effect.gen(function*() {
        const state = yield* makeState
        const bridge = ClusterMachine.make("ConflictCounter", makeCounter(state), { version: "1" })
        const storage = makeTestStorage()
        const key = storageKey("ConflictCounter", "counter-1")
        const emitted: Array<unknown> = []
        yield* Effect.gen(function*() {
          yield* TestClock.adjust(1)
          const client = (yield* bridge.entity.client)("counter-1")
          assertAccepted(yield* client.send(increment()))
          storage.write(key, withCount(10))
          assertAccepted(yield* client.send(increment()))
          assert.strictEqual(storage.loads, 2)
          assert.strictEqual(storage.commitAttempts, 3)
          assert.strictEqual(storage.commits, 2)
          assert.deepStrictEqual(countOf(storage, key), { revision: 3, value: encodedCount(11) })
          assert.deepStrictEqual(emitted, [new Changed({ value: 1 }), new Changed({ value: 11 })])
          assertAccepted(yield* client.send(increment()))
          assert.strictEqual(storage.loads, 2)
          assert.deepStrictEqual(countOf(storage, key), { revision: 4, value: encodedCount(12) })
        }).pipe(Effect.provide(makeLayer(bridge, storage.service, (event) =>
          Effect.sync(() => {
            emitted.push(event)
          }))))
      }))
    it.effect("rejects a request when the checkpoint keeps advancing", () =>
      Effect.gen(function*() {
        const state = yield* makeState
        const bridge = ClusterMachine.make("ContendedCounter", makeCounter(state), { version: "1" })
        const storage = makeTestStorage()
        const key = storageKey("ContendedCounter", "counter-1")
        const emitted: Array<unknown> = []
        yield* Effect.gen(function*() {
          yield* TestClock.adjust(1)
          const client = (yield* bridge.entity.client)("counter-1")
          assertAccepted(yield* client.send(increment()))
          let value = 10
          storage.onCommit(() => storage.write(key, withCount(value++)))
          assertRejected(yield* client.send(increment()), "RevisionConflict")
          assert.strictEqual(storage.loads, 2)
          assert.strictEqual(storage.commitAttempts, 3)
          assert.strictEqual(storage.commits, 1)
          assert.deepStrictEqual(countOf(storage, key), { revision: 3, value: encodedCount(11) })
          assert.deepStrictEqual(emitted, [new Changed({ value: 1 })])
          storage.onCommit(() => {})
          assertAccepted(yield* client.send(increment()))
          assert.strictEqual(storage.loads, 3)
          assert.deepStrictEqual(countOf(storage, key), { revision: 4, value: encodedCount(12) })
        }).pipe(Effect.provide(makeLayer(bridge, storage.service, (event) =>
          Effect.sync(() => {
            emitted.push(event)
          }))))
      }))
    it.effect("loads again when another instance stores the first checkpoint", () =>
      Effect.gen(function*() {
        const state = yield* makeState
        const bridge = ClusterMachine.make("FirstConflictCounter", makeCounter(state), { version: "1" })
        const storage = makeTestStorage()
        const key = storageKey("FirstConflictCounter", "counter-1")
        yield* Effect.gen(function*() {
          yield* TestClock.adjust(1)
          const client = (yield* bridge.entity.client)("counter-1")
          storage.onCommit(() => {
            storage.onCommit(() => {})
            storage.entries.set(
              key,
              withCount(10)({
                definitionId: "Counter",
                version: "1",
                revision: 1,
                origin: request(Snowflake.Snowflake(0)),
                status: active,
                snapshot: { version: 2, _tag: "MachineSnapshot", active: [] }
              })
            )
          })
          assertAccepted(yield* client.send(increment()))
          assert.strictEqual(storage.loads, 2)
          assert.deepStrictEqual(countOf(storage, key), { revision: 2, value: encodedCount(11) })
        }).pipe(Effect.provide(makeLayer(bridge, storage.service, () => Effect.void)))
      }))
  })
  describe("requests against a newer state", () => {
    class Work extends Schema.TaggedClass<Work>("Work")("Work", {}) {}
    const targets = ["Throwing", "Unencodable", "Emitting", "Commanding", "Finished"] as const
    class Go extends Schema.TaggedClass<Go>("Go")("Go", { to: Schema.Literals(targets) }) {}
    class Sealed extends Schema.TaggedClass<Sealed>("Sealed")("Sealed", {
      value: Schema.String.pipe(Schema.decode({
        decode: SchemaGetter.passthrough<string>(),
        encode: SchemaGetter.transformEffect<string, string>((value) =>
          value === "open" ? Effect.succeed(value) : Effect.fail(new SchemaIssue.InvalidValue({ message: "sealed" }))
        )
      }))
    }) {}
    const Root = Machine.state({
      states: {
        Fresh: {},
        Throwing: {},
        Unencodable: Sealed,
        Emitting: {},
        Commanding: {},
        Finished: { type: "final" }
      }
    })
    const rejectsWork: boolean = true
    const makeStaged = () =>
      Machine.make({
        id: "Staged",
        root: Root,
        events: Machine.eventsFromSchemas(Work, Go),
        emittedEvents: Machine.emittedEventsFromSchemas(Changed)
      }).handle({
        initial: { target: "Fresh" },
        states: {
          Fresh: {
            on: {
              Work: { stay: true },
              Go: {
                branches: [
                  { target: "Throwing" },
                  { target: "Unencodable" },
                  { target: "Emitting" },
                  { target: "Commanding" },
                  { target: "Finished" }
                ],
                resolve: ({ event, select }) => {
                  switch (event.to) {
                    case "Throwing":
                      return select.target("Throwing")
                    case "Unencodable":
                      return select.target("Unencodable", { data: new Sealed({ value: "open" }), decoded: true })
                    case "Emitting":
                      return select.target("Emitting")
                    case "Commanding":
                      return select.target("Commanding")
                    case "Finished":
                      return select.target("Finished")
                  }
                }
              }
            }
          },
          Throwing: {
            on: {
              Work: {
                branches: [{ target: "Fresh" }],
                resolve: ({ select }) => {
                  if (rejectsWork) throw new Error("not in this state")
                  return select.target("Fresh")
                }
              }
            }
          },
          Unencodable: {
            on: { Work: { target: "Unencodable", decoded: true, data: () => new Sealed({ value: "sealed" }) } }
          },
          Emitting: {
            on: {
              Work: {
                branches: [{ target: "Fresh" }],
                resolve: ({ select }, enqueue) => {
                  enqueue.emit(new Changed({ value: 1 }))
                  return select.target("Fresh")
                }
              }
            }
          },
          Commanding: {
            on: {
              Work: {
                branches: [{ target: "Fresh" }],
                resolve: ({ select }, enqueue) => {
                  enqueue.stop(UnsupportedChildAddress)
                  return select.target("Fresh")
                }
              }
            }
          }
        }
      })
    const rejections = {
      Throwing: "TransitionFailure",
      Unencodable: "SnapshotEncodeFailure",
      Emitting: "EmissionFailure",
      Commanding: "UnsupportedProcessLocal",
      Finished: undefined
    } as const
    for (const to of targets) {
      const reason = rejections[to]
      it.effect(`accepts a redelivery that ${reason === undefined ? "reaches a final state" : `would be ${reason}`}`, () =>
        Effect.gen(function*() {
          const type = `Redelivered${to}`
          const bridge = ClusterMachine.make(type, makeStaged(), { version: "1" })
          const storage = makeTestStorage()
          const key = storageKey(type, "staged-1")
          yield* Effect.gen(function*() {
            yield* TestClock.adjust(1)
            const client = (yield* bridge.entity.client)("staged-1")
            assertAccepted(yield* client.send(new Work({})))
            assertAccepted(yield* client.send(new Go({ to })))
            const stored = storage.entries.get(key)
            const [first] = yield* sentRequestIds
            assert.deepStrictEqual(yield* redeliver(first!), { _tag: "Accepted" })
            // Final states reach the commit; the others ask before rejecting.
            assert.strictEqual(storage.commitAttempts, reason === undefined ? 3 : 2)
            assert.strictEqual(storage.loads, reason === undefined ? 1 : 2)
            assert.strictEqual(storage.commits, 2)
            assert.strictEqual(storage.entries.get(key), stored)
            if (reason !== undefined) {
              // The same event is rejected when it is new, and memory stays valid throughout.
              assertRejected(yield* client.send(new Work({})), reason)
              assert.strictEqual(storage.loads, 3)
              assert.strictEqual(storage.entries.get(key), stored)
            }
            const loads = storage.loads
            assertAccepted(yield* client.send(new Go({ to: "Finished" })))
            assert.strictEqual(storage.loads, loads)
            assert.strictEqual(storage.commits, 3)
          }).pipe(Effect.provide(makeLayer(bridge, storage.service)))
        }))
    }
    it.effect("keeps memory valid after a first request is rejected before its commit", () =>
      Effect.gen(function*() {
        const bridge = ClusterMachine.make("RejectedFirst", makeStaged(), { version: "1" })
        const storage = makeTestStorage()
        const key = storageKey("RejectedFirst", "staged-1")
        yield* Effect.gen(function*() {
          yield* TestClock.adjust(1)
          const client = (yield* bridge.entity.client)("staged-1")
          assertAccepted(yield* client.send(new Go({ to: "Throwing" })))
          assertRejected(yield* client.send(new Work({})), "TransitionFailure")
          assertRejected(yield* client.send(new Work({})), "TransitionFailure")
          // One load for the state, and one per rejection to recognize a redelivery.
          assert.strictEqual(storage.loads, 3)
          assert.strictEqual(storage.commitAttempts, 1)
          assertAccepted(yield* client.send(new Go({ to: "Finished" })))
          assert.strictEqual(storage.loads, 3)
          assert.strictEqual(storage.entries.get(key)?.revision, 2)
        }).pipe(Effect.provide(makeLayer(bridge, storage.service)))
      }))
    it.effect("does not reject a request because of a state another instance replaced", () =>
      Effect.gen(function*() {
        const bridge = ClusterMachine.make("StaleRejection", makeStaged(), { version: "1" })
        const storage = makeTestStorage()
        const key = storageKey("StaleRejection", "staged-1")
        yield* Effect.gen(function*() {
          yield* TestClock.adjust(1)
          const client = (yield* bridge.entity.client)("staged-1")
          assertAccepted(yield* client.send(new Go({ to: "Throwing" })))
          storage.write(key, (checkpoint) => ({
            ...checkpoint,
            snapshot: { ...checkpoint.snapshot, active: [{ path: "" }, { path: "Fresh" }] }
          }))
          assertAccepted(yield* client.send(new Work({})))
          // Asked before rejecting, then loaded for the retry.
          assert.strictEqual(storage.loads, 3)
          assert.strictEqual(storage.entries.get(key)?.revision, 3)
        }).pipe(Effect.provide(makeLayer(bridge, storage.service)))
      }))
    it.effect("rejects as a persistence failure when a redelivery cannot be ruled out", () =>
      Effect.gen(function*() {
        const bridge = ClusterMachine.make("UnknownRedelivery", makeStaged(), { version: "1" })
        const storage = makeTestStorage()
        yield* Effect.gen(function*() {
          yield* TestClock.adjust(1)
          const client = (yield* bridge.entity.client)("staged-1")
          assertAccepted(yield* client.send(new Go({ to: "Throwing" })))
          storage.failNextLoad()
          assertRejected(yield* client.send(new Work({})), "PersistenceFailure")
          assert.strictEqual(storage.loads, 2)
          assertAccepted(yield* client.send(new Go({ to: "Finished" })))
          assert.strictEqual(storage.loads, 3)
        }).pipe(Effect.provide(makeLayer(bridge, storage.service)))
      }))
  })
  describe("redelivery to a live instance", () => {
    it.effect("recognizes an older request without changing state or emissions", () =>
      Effect.gen(function*() {
        const state = yield* makeState
        const bridge = ClusterMachine.make("RedeliveredCounter", makeCounter(state), { version: "1" })
        const storage = makeTestStorage()
        const key = storageKey("RedeliveredCounter", "counter-1")
        const emitted: Array<unknown> = []
        yield* Effect.gen(function*() {
          yield* TestClock.adjust(1)
          const client = (yield* bridge.entity.client)("counter-1")
          assertAccepted(yield* client.send(increment()))
          assertAccepted(yield* client.send(increment()))
          const [first] = yield* sentRequestIds
          assert.deepStrictEqual(yield* redeliver(first!), { _tag: "Accepted" })
          assert.strictEqual(storage.commitAttempts, 3)
          assert.strictEqual(storage.commits, 2)
          assert.deepStrictEqual(countOf(storage, key), { revision: 2, value: encodedCount(2) })
          assert.deepStrictEqual(emitted, [new Changed({ value: 1 }), new Changed({ value: 2 })])
          assertAccepted(yield* client.send(increment()))
          assert.strictEqual(storage.loads, 1)
          assert.deepStrictEqual(countOf(storage, key), { revision: 3, value: encodedCount(3) })
        }).pipe(Effect.provide(makeLayer(bridge, storage.service, (event) =>
          Effect.sync(() => {
            emitted.push(event)
          }))))
      }))
    it.effect("accepts a redelivery whose commit or transaction fails", () =>
      Effect.gen(function*() {
        const state = yield* makeState
        const bridge = ClusterMachine.make("FailedRedelivery", makeCounter(state), { version: "1" })
        const storage = makeTestStorage()
        const key = storageKey("FailedRedelivery", "counter-1")
        let failNext = false
        const transaction = rollingBack(storage, [])
        const withTransaction: typeof transaction = (effect) =>
          transaction(Effect.tap(effect, () =>
            Effect.sync(() => {
              if (!failNext) return
              failNext = false
              throw new Error("commit unavailable")
            })))
        yield* Effect.gen(function*() {
          yield* TestClock.adjust(1)
          const client = (yield* bridge.entity.client)("counter-1")
          assertAccepted(yield* client.send(increment()))
          const [first] = yield* sentRequestIds
          storage.failNextCommit()
          assert.deepStrictEqual(yield* redeliver(first!), { _tag: "Accepted" })
          assert.strictEqual(storage.loads, 2)
          // This redelivery loads, because the failed commit left memory unknown.
          failNext = true
          assert.deepStrictEqual(yield* redeliver(first!), { _tag: "Accepted" })
          assert.strictEqual(storage.loads, 4)
          assert.strictEqual(storage.commits, 1)
          assert.deepStrictEqual(countOf(storage, key), { revision: 1, value: encodedCount(1) })
        }).pipe(
          Effect.provide(makeLayer(bridge, storage.service, () => Effect.void, undefined, { withTransaction }))
        )
      }))
    it.effect("recognizes a request that another instance committed", () =>
      Effect.gen(function*() {
        const state = yield* makeState
        const bridge = ClusterMachine.make("HandedOverCounter", makeCounter(state), { version: "1" })
        const storage = makeTestStorage()
        const key = storageKey("HandedOverCounter", "counter-1")
        const emitted: Array<unknown> = []
        yield* Effect.gen(function*() {
          yield* TestClock.adjust(1)
          const driver = yield* MessageStorage.MemoryDriver
          const client = (yield* bridge.entity.client)("counter-1")
          assertAccepted(yield* client.send(increment()))
          // The previous owner commits the same request while it is applied here.
          storage.onCommit(() => {
            storage.onCommit(() => {})
            storage.write(key, withCount(2))
            storage.requests.get(key)!.add(Snowflake.Snowflake(driver.journal.at(-1)!.requestId))
          })
          assertAccepted(yield* client.send(increment()))
          assert.strictEqual(storage.commits, 1)
          assert.deepStrictEqual(countOf(storage, key), { revision: 2, value: encodedCount(2) })
          assert.deepStrictEqual(emitted, [new Changed({ value: 1 })])
          // Memory is now behind storage, which the next commit notices.
          assertAccepted(yield* client.send(increment()))
          assert.deepStrictEqual(countOf(storage, key), { revision: 3, value: encodedCount(3) })
        }).pipe(Effect.provide(makeLayer(bridge, storage.service, (event) =>
          Effect.sync(() => {
            emitted.push(event)
          }))))
      }))
  })
  it.effect("orders the results of the in-memory storage", () =>
    Effect.gen(function*() {
      const storage = yield* ClusterMachine.Storage
      const address = {
        entityType: "MemoryCounter",
        entityId: "counter-1",
        shardId: { group: "default", id: 1 }
      } as any
      const { Committed, Duplicate, RevisionConflict } = ClusterMachine.CommitResult
      const checkpoint = (revision: number, requestId: number): ClusterMachine.Checkpoint => ({
        definitionId: "Counter",
        version: "1",
        revision,
        origin: request(Snowflake.Snowflake(requestId)),
        status: active,
        snapshot: { version: 2, _tag: "MachineSnapshot", active: [{ path: "" }] }
      })
      const loadedRevision = storage.loadForRequest(address, Snowflake.Snowflake(99)).pipe(
        Effect.map(({ checkpoint, processed }) => {
          assert.isFalse(processed)
          return Option.map(checkpoint, ({ revision }) => revision)
        })
      )
      // Without a checkpoint, only the first revision commits.
      assert.deepStrictEqual(yield* storage.commit(address, checkpoint(2, 1)), RevisionConflict())
      assert.deepStrictEqual(yield* storage.commit(address, checkpoint(0, 1)), RevisionConflict())
      assert.deepStrictEqual(yield* loadedRevision, Option.none())
      assert.deepStrictEqual(yield* storage.commit(address, checkpoint(1, 1)), Committed())
      // A conflict records neither the checkpoint nor the request id.
      assert.deepStrictEqual(yield* storage.commit(address, checkpoint(1, 2)), RevisionConflict())
      assert.deepStrictEqual(yield* storage.commit(address, checkpoint(3, 2)), RevisionConflict())
      assert.isFalse((yield* storage.loadForRequest(address, Snowflake.Snowflake(2))).processed)
      assert.deepStrictEqual(yield* loadedRevision, Option.some(1))
      assert.deepStrictEqual(yield* storage.commit(address, checkpoint(2, 2)), Committed())
      // A committed request id is a duplicate whatever its revision.
      for (const revision of [0, 1, 2, 3, 9]) {
        assert.deepStrictEqual(yield* storage.commit(address, checkpoint(revision, 1)), Duplicate())
      }
      assert.deepStrictEqual(yield* loadedRevision, Option.some(2))
    }).pipe(Effect.provide(ClusterMachine.layerMemory)))
  describe("invoked effects", () => {
    /** One run of invoked work, which the test ends. */
    interface Run {
      readonly input: unknown
      readonly result: Deferred.Deferred<string, { readonly reason: string }>
      stopped: boolean
    }
    const makeWork = () => {
      const runs: Array<Run> = []
      return {
        runs,
        run: (input: unknown) =>
          Effect.suspend(() => {
            const run: Run = { input, result: Deferred.makeUnsafe(), stopped: false }
            runs.push(run)
            return Effect.onInterrupt(Deferred.await(run.result), () =>
              Effect.sync(() => {
                run.stopped = true
              }))
          })
      }
    }
    type Work = ReturnType<typeof makeWork>
    const succeed = (run: Run | undefined, output: string) => Deferred.succeed(run!.result, output)

    const Events = Machine.events({
      Load: { id: Schema.String },
      Note: {},
      Cancel: {},
      Reload: {},
      Finish: {}
    })
    /** The payloads a client sends. */
    const Event = {
      Load: (fields: { readonly id: string }) => ({ _tag: "Load", ...fields }),
      Note: () => ({ _tag: "Note" }),
      Cancel: () => ({ _tag: "Cancel" }),
      Reload: () => ({ _tag: "Reload" }),
      Finish: () => ({ _tag: "Finish" })
    }
    const loaderRoot = Machine.state({
      states: {
        Idle: {},
        Loading: { fields: { id: Schema.String, notes: Schema.Number } },
        Loaded: { fields: { result: Schema.String } },
        Failed: { fields: { reason: Schema.String } },
        Finished: { type: "final" }
      }
    })
    const makeLoader = (work: Work, inputs: Array<unknown> = []) =>
      Machine.make({
        id: "Loader",
        root: loaderRoot,
        events: Events,
        effects: { load: (id: string) => work.run(id) }
      }).handle({
        initial: { target: "Idle" },
        states: {
          Idle: { on: { Load: { target: "Loading", data: ({ event }) => ({ id: event.id, notes: 0 }) } } },
          Loading: {
            invoke: {
              src: "load",
              input: ({ event, state }) => {
                inputs.push((event as { readonly _tag: unknown })._tag)
                return state.id
              },
              onDone: { target: "Loaded", data: ({ output }) => ({ result: output }) },
              onFailure: { target: "Failed", data: ({ error }) => ({ reason: error.reason }) }
            },
            on: {
              Note: { update: { Loading: ({ state }) => ({ ...state, notes: state.notes + 1 }) } },
              Cancel: { target: "Idle" },
              Reload: { target: "Loading", reenter: true, data: ({ state }) => state },
              Finish: { target: "Finished" }
            }
          },
          Loaded: { on: { Load: { target: "Loading", data: ({ event }) => ({ id: event.id, notes: 0 }) } } },
          Failed: {}
        }
      })

    const leafOf = (checkpoint: ClusterMachine.Checkpoint | undefined) => checkpoint?.snapshot.active.at(-1)
    const pathOf = (checkpoint: ClusterMachine.Checkpoint | undefined) => leafOf(checkpoint)?.path
    const until = Effect.fnUntraced(function*(condition: () => boolean) {
      for (let attempt = 0; attempt < 500 && !condition(); attempt++) yield* Effect.yieldNow
      assert.isTrue(condition(), `Condition was not reached: ${String(condition)}`)
    })
    /** Lets everything that does not wait for time happen. */
    const settle = Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow, { discard: true })

    const run = <A, E, R>(
      machine: Machine.Machine.Any,
      options: {
        readonly type?: string
        readonly enqueue?: (event: any) => Effect.Effect<void, unknown>
        readonly idle?: Duration.Input
        readonly withTransaction?: MessageStorage.MessageStorage["Service"]["withTransaction"]
        readonly storage?: TestStorage
        readonly inMemoryThreshold?: Duration.Input
      },
      body: (host: {
        readonly storage: TestStorage
        readonly key: string
        readonly stored: () => ClusterMachine.Checkpoint | undefined
        readonly send: (event: object) => Effect.Effect<ClusterMachine.Accepted | ClusterMachine.Rejected>
        readonly driver: MessageStorage.MemoryDriver["Service"]
        readonly sharding: Sharding.Sharding["Service"]
      }) => Effect.Effect<A, E, R>
    ) => {
      const type = options.type ?? "Worker"
      const storage = options.storage ?? makeTestStorage()
      const bridge = adapt(type, machine)
      const key = storageKey(type, "worker-1")
      return Effect.gen(function*() {
        yield* TestClock.adjust(1)
        const client = (yield* bridge.entity.client)("worker-1")
        return yield* body({
          storage,
          key,
          stored: () => storage.entries.get(key),
          send: (event) => Effect.orDie(client.send(event as never) as Effect.Effect<any, unknown>),
          driver: yield* MessageStorage.MemoryDriver,
          sharding: yield* Sharding.Sharding
        })
      }).pipe(Effect.provide(makeLayer(
        bridge,
        storage.service,
        options.enqueue,
        options.idle,
        options.withTransaction === undefined ? undefined : { withTransaction: options.withTransaction },
        options.inMemoryThreshold
      )))
    }

    /** Keep-alive requests that wait for a reply, which is what revives an entity. */
    /** Delayed messages that wake the entity for a long timer, not yet processed. */
    const wakes = (driver: MessageStorage.MemoryDriver["Service"]) =>
      Array.from(driver.unprocessed).filter((envelope) => envelope._tag === "Request" && envelope.tag === "wake")
    const keptAlive = (driver: MessageStorage.MemoryDriver["Service"]) =>
      Array.from(driver.unprocessed).filter((envelope) =>
        envelope._tag === "Request" && envelope.tag === "Cluster/Entity/keepAlive"
      ).length
    /** The entity sent one keep-alive request, and nothing answered it. */
    const assertHeld = (driver: MessageStorage.MemoryDriver["Service"]) => {
      const sent = driver.journal.filter((envelope) =>
        envelope._tag === "Request" && envelope.tag === "Cluster/Entity/keepAlive"
      )
      assert.deepStrictEqual(sent.map(({ requestId }) => driver.requests.get(requestId)?.replies), [[]])
      assert.strictEqual(keptAlive(driver), 1)
    }

    it.effect("moves the machine with the output of its effect, without another request", () =>
      Effect.gen(function*() {
        const work = makeWork()
        yield* run(makeLoader(work), {}, ({ key, send, storage, stored }) =>
          Effect.gen(function*() {
            assertAccepted(yield* send(Event.Load({ id: "a" })))
            assert.deepStrictEqual(work.runs.map(({ input }) => input), ["a"])
            assert.strictEqual(pathOf(stored()), "Loading")
            assert.strictEqual(storage.commits, 1)
            yield* succeed(work.runs[0], "document a")
            yield* until(() => pathOf(stored()) === "Loaded")
            assert.deepStrictEqual(leafOf(stored())?.value, { _tag: "Loaded", result: "document a" })
            assert.deepStrictEqual(storage.entries.get(key)?.origin, {
              _tag: "Invocation",
              path: "Loading",
              id: "load"
            })
            assert.strictEqual(stored()?.revision, 2)
            assert.deepStrictEqual(stored()?.status, active)
            // The wake-up loaded, and nothing else had to.
            assert.strictEqual(storage.loads, 1)
            assert.isTrue(storage.transactionFlags.every(Boolean))
            assert.strictEqual(work.runs.length, 1)
          }))
      }))

    it.effect("routes a typed failure through onFailure", () =>
      Effect.gen(function*() {
        const work = makeWork()
        yield* run(makeLoader(work), {}, ({ send, stored }) =>
          Effect.gen(function*() {
            assertAccepted(yield* send(Event.Load({ id: "missing" })))
            yield* Deferred.fail(work.runs[0]!.result, { reason: "not found" })
            yield* until(() => pathOf(stored()) === "Failed")
            assert.deepStrictEqual(leafOf(stored())?.value, { _tag: "Failed", reason: "not found" })
            assert.deepStrictEqual(stored()?.status, active)
          }))
      }))

    it.effect("stops the work of a state it leaves, and runs it again when it returns", () =>
      Effect.gen(function*() {
        const work = makeWork()
        const inputs: Array<unknown> = []
        yield* run(makeLoader(work, inputs), {}, ({ driver, send, storage, stored }) =>
          Effect.gen(function*() {
            assertAccepted(yield* send(Event.Load({ id: "a" })))
            assert.strictEqual(keptAlive(driver), 1)
            assertAccepted(yield* send(Event.Cancel()))
            assert.isTrue(work.runs[0]!.stopped)
            yield* succeed(work.runs[0], "late")
            yield* settle
            assert.strictEqual(pathOf(stored()), "Idle")
            assert.strictEqual(storage.commits, 2)
            assert.strictEqual(keptAlive(driver), 0)

            assertAccepted(yield* send(Event.Load({ id: "b" })))
            // Reentering stops the first activation and starts a second one.
            assertAccepted(yield* send(Event.Reload()))
            assert.deepStrictEqual(work.runs.map(({ stopped }) => stopped), [true, true, false])
            assert.deepStrictEqual(inputs, ["Load", "Load", "Reload"])
            yield* succeed(work.runs[1], "stale")
            yield* settle
            assert.strictEqual(pathOf(stored()), "Loading")
            assert.strictEqual(storage.commits, 4)
            assert.strictEqual(keptAlive(driver), 1)
            yield* succeed(work.runs[2], "fresh")
            yield* until(() => pathOf(stored()) === "Loaded")
            assert.deepStrictEqual(leafOf(stored())?.value, { _tag: "Loaded", result: "fresh" })
            assert.deepStrictEqual(stored()?.status, active)
          }))
      }))

    const lateExits = {
      "a result": Exit.succeed("stale"),
      "a typed failure": Exit.fail({ reason: "stale" }),
      "a defect": Exit.die(new Error("stale"))
    }
    for (const [name, exit] of Object.entries(lateExits)) {
      it.effect(`ignores ${name} that ends the work while the exit of its state is being stored`, () =>
        Effect.gen(function*() {
          const work = makeWork()
          const gate = yield* Latch.make()
          yield* run(makeLoader(work), {}, ({ send, storage, stored }) =>
            Effect.gen(function*() {
              assertAccepted(yield* send(Event.Load({ id: "a" })))
              storage.holdCommits(gate.await)
              const reload = yield* Effect.forkChild(send(Event.Reload()), { startImmediately: true })
              yield* settle
              yield* Deferred.done(work.runs[0]!.result, exit)
              yield* settle
              storage.holdCommits(Effect.void)
              yield* gate.open
              assertAccepted(yield* Fiber.join(reload))
              yield* settle
              assert.strictEqual(pathOf(stored()), "Loading")
              assert.strictEqual(work.runs.length, 2)
              assert.isFalse(work.runs[1]!.stopped)
              assert.deepStrictEqual(stored()?.status, active)
              assert.strictEqual(storage.commits, 2)
            }))
        }))
    }

    const makeParallel = (order: Array<string>) =>
      Machine.make({
        id: "Parallel",
        root: Machine.state({
          states: {
            Idle: {},
            Active: {
              type: "parallel",
              states: {
                left: { states: { Busy: {}, Done: {} } },
                right: { states: { Busy: {}, Done: {} } }
              }
            }
          }
        }),
        events: Machine.events({ Go: {}, Stop: {} }),
        effects: {
          work: (name: string) =>
            Effect.suspend(() => {
              order.push(name)
              return Effect.onInterrupt(Effect.never, () => Effect.sync(() => order.push(`stopped ${name}`)))
            }),
          quick: (name: string) => Effect.sync(() => void order.push(name))
        }
      }).handle({
        initial: { target: "Idle" },
        states: {
          Idle: { on: { Go: { target: "Active" } } },
          Active: {
            on: { Stop: { target: "Idle" } },
            states: {
              left: {
                initial: { target: "Active.left.Busy" },
                states: {
                  Busy: {
                    invoke: [
                      { src: "work", id: "zeta", input: () => "left zeta" },
                      { src: "quick", id: "alpha", input: () => "left alpha", onDone: { target: "Active.left.Done" } }
                    ]
                  },
                  Done: {}
                }
              },
              right: {
                invoke: { src: "work", id: "region", input: () => "right region" },
                initial: { target: "Active.right.Busy" },
                states: { Busy: { invoke: { src: "work", id: "busy", input: () => "right busy" } }, Done: {} }
              }
            }
          }
        }
      })

    it.effect("runs the work of two regions in the order of the resolver", () =>
      Effect.gen(function*() {
        const order: Array<string> = []
        yield* run(makeParallel(order), {}, ({ driver, send, storage, stored }) =>
          Effect.gen(function*() {
            assertAccepted(yield* send({ _tag: "Go" }))
            assert.deepStrictEqual(order.slice(0, 4), ["right region", "left zeta", "left alpha", "right busy"])
            yield* until(() => storage.commits === 2)
            // `left alpha` left its state, which stopped only its sibling.
            yield* until(() => order.length === 5)
            assert.strictEqual(order[4], "stopped left zeta")
            assert.deepStrictEqual(stored()?.origin, { _tag: "Invocation", path: "Active.left.Busy", id: "alpha" })
            assert.deepStrictEqual(
              stored()?.snapshot.active.map(({ path }) => path),
              ["", "Active", "Active.left", "Active.left.Done", "Active.right", "Active.right.Busy"]
            )
            assert.strictEqual(keptAlive(driver), 1)
            assertAccepted(yield* send({ _tag: "Stop" }))
            assert.deepStrictEqual(new Set(order.slice(5)), new Set(["stopped right region", "stopped right busy"]))
            yield* settle
            assert.strictEqual(keptAlive(driver), 0)
          }))
      }))

    describe("failed machine", () => {
      class LoadError extends Data.TaggedError("LoadError")<{ readonly reason: string }> {}
      const failingWork: Record<string, { readonly effect: Effect.Effect<never, any>; readonly failure: RegExp }> = {
        "a failure without onFailure": {
          effect: Effect.fail(new LoadError({ reason: "not found" })),
          failure: /^LoadError: \{.*"reason":"not found".*\}$/
        },
        "a defect": { effect: Effect.die(new TypeError("broken")), failure: /^TypeError: broken$/ },
        "an interruption of its own": { effect: Effect.interrupt, failure: /^Interrupted$/ },
        "an interruption of its own fiber": {
          effect: Effect.withFiber((fiber) => {
            fiber.interruptUnsafe()
            return Effect.never
          }),
          failure: /^Interrupted$/
        },
        "a missing service": {
          effect: Effect.service(
            Context.Service<never, Effect.Effect<never>>("test/Missing")
          ) as Effect.Effect<never>,
          failure: /Service not found: test\/Missing/
        },
        "completion without onDone": {
          effect: Effect.void as Effect.Effect<never>,
          failure: /^Error: Invocation "main" completed without the required onDone handler$/
        }
      }
      const makeFailing = (work: Work, effect: Effect.Effect<never, any>) =>
        Machine.make({
          id: "Failing",
          root: loaderRoot,
          events: Events,
          effects: {
            side: work.run("side"),
            main: Effect.andThen(Effect.orDie(work.run("main")), effect) as Effect.Effect<never>
          }
        }).handle({
          initial: { target: "Idle" },
          states: {
            Idle: { on: { Load: { target: "Loading", data: ({ event }) => ({ id: event.id, notes: 0 }) } } },
            Loading: {
              invoke: [{ src: "side", onDone: { stay: true }, onFailure: { stay: true } }, { src: "main" }],
              on: { Note: { update: { Loading: ({ state }) => ({ ...state, notes: state.notes + 1 }) } } }
            }
          }
        })
      for (const [name, { effect, failure }] of Object.entries(failingWork)) {
        it.effect(`is stored after ${name}`, () =>
          Effect.gen(function*() {
            const work = makeWork()
            yield* run(makeFailing(work, effect), { idle: 0 }, ({ driver, send, sharding, storage, stored }) =>
              Effect.gen(function*() {
                assertAccepted(yield* send(Event.Load({ id: "a" })))
                const [loading] = yield* sentRequestIds
                assertAccepted(yield* send(Event.Note()))
                const before = stored()!
                assert.strictEqual(keptAlive(driver), 1)
                yield* succeed(work.runs[1], "end")
                yield* until(() =>
                  stored()?.status._tag === "Failed"
                )
                const after = stored()!
                assert.strictEqual(after.revision, before.revision + 1)
                assert.deepStrictEqual(after.snapshot, before.snapshot)
                assert.deepStrictEqual(after.origin, { _tag: "Invocation", path: "Loading", id: "main" })
                assert(after.status._tag === "Failed")
                assert.match(after.status.failure, failure)
                // Its other work is stopped, and it is not kept alive.
                yield* until(() => work.runs[0]!.stopped)
                yield* settle
                assert.strictEqual(keptAlive(driver), 0)

                const rejected = yield* send(Event.Note())
                assertRejected(rejected, "MachineFailed")
                assert.instanceOf(rejected, ClusterMachine.Rejected)
                assert.strictEqual(rejected.message, after.status.failure)
                // Committed before the failure, so it is still accepted.
                assert.deepStrictEqual(yield* redeliver(loading!), { _tag: "Accepted" })

                // Another instance finds the failure, runs nothing, and answers the same.
                yield* TestClock.adjust(5000)
                yield* settle
                assert.strictEqual(yield* sharding.activeEntityCount, 0)
                const loads = storage.loads
                assertRejected(yield* send(Event.Note()), "MachineFailed")
                assert.isTrue(storage.loads > loads)
                assert.deepStrictEqual(yield* redeliver(loading!), { _tag: "Accepted" })
                assert.strictEqual(work.runs.length, 2)
                assert.strictEqual(stored(), after)
                assert.strictEqual(keptAlive(driver), 0)
              }))
          }))
      }

      it.effect("stores a failure text of bounded length", () =>
        Effect.gen(function*() {
          const work = makeWork()
          yield* run(makeFailing(work, Effect.die(new Error("😀".repeat(5000)))), {}, ({ send, stored }) =>
            Effect.gen(function*() {
              assertAccepted(yield* send(Event.Load({ id: "a" })))
              yield* succeed(work.runs[1], "end")
              yield* until(() =>
                stored()?.status._tag === "Failed"
              )
              const status = stored()!.status
              assert(status._tag === "Failed")
              assert.isAtMost(status.failure.length, 4096)
              assert.strictEqual(status.failure, encodeURIComponent(status.failure) && status.failure)
              assert.isTrue(status.failure.endsWith("…"))
            }))
        }))

      class Sealed extends Schema.TaggedClass<Sealed>("Sealed")("Sealed", {
        value: Schema.String.pipe(Schema.decode({
          decode: SchemaGetter.passthrough<string>(),
          encode: SchemaGetter.transformEffect<string, string>((value) =>
            value === "open" ? Effect.succeed(value) : Effect.fail(new SchemaIssue.InvalidValue({ message: "sealed" }))
          )
        }))
      }) {}
      const outcomes = {
        throw: /^Error: cannot leave$/,
        schema: /MachineSchemaDecodeError/,
        encode: /^SnapshotEncodeFailure: /,
        command: /^UnsupportedProcessLocal: Machine commands on Cluster stop only an invoked child machine$/,
        emission: /^EmissionFailure: No durable enqueue handler was configured$/
      }
      for (const [to, failure] of Object.entries(outcomes)) {
        it.effect(`is stored when the outcome cannot be applied (${to})`, () =>
          Effect.gen(function*() {
            const work = makeWork()
            const machine = Machine.make({
              id: "Unapplicable",
              root: Machine.state({
                states: { Working: {}, Sealed, Value: { fields: { value: Schema.Number } }, Idle: {} }
              }),
              events: Events,
              emittedEvents: Machine.emittedEventsFromSchemas(Changed),
              effects: { load: work.run("load") }
            }).handle({
              initial: { target: "Working" },
              states: {
                Working: {
                  on: { Note: { stay: true } },
                  invoke: {
                    src: "load",
                    onFailure: { stay: true },
                    onDone: {
                      branches: [{ target: "Sealed" }, { target: "Value" }, { target: "Idle" }],
                      resolve: ({ select }, enqueue) => {
                        switch (to) {
                          case "throw":
                            throw new Error("cannot leave")
                          case "schema":
                            return select.target("Value", { data: { value: "text" as never } })
                          case "encode":
                            return select.target("Sealed", { data: new Sealed({ value: "sealed" }), decoded: true })
                          case "command":
                            enqueue.stop(UnsupportedChildAddress)
                            return select.target("Idle")
                          default:
                            enqueue.emit(new Changed({ value: 1 }))
                            return select.target("Idle")
                        }
                      }
                    }
                  }
                }
              }
            })
            yield* run(machine, {}, ({ driver, send, storage, stored }) =>
              Effect.gen(function*() {
                assertAccepted(yield* send(Event.Note()))
                yield* succeed(work.runs[0], "end")
                yield* until(() => stored()?.status._tag === "Failed")
                const status = stored()!.status
                assert(status._tag === "Failed")
                assert.match(status.failure, failure)
                assert.strictEqual(pathOf(stored()), "Working")
                assert.strictEqual(storage.commits, 2)
                yield* settle
                assert.strictEqual(keptAlive(driver), 0)
                assertRejected(yield* send(Event.Note()), "MachineFailed")
              }))
          }))
      }

      it.effect("is stored when a source cannot be constructed, after the state that starts it", () =>
        Effect.gen(function*() {
          const work = makeWork()
          const started: Array<string> = []
          const machine = Machine.make({
            id: "Unstartable",
            root: loaderRoot,
            events: Events,
            effects: { first: work.run("first"), second: (_: string) => Effect.never, third: work.run("third") }
          }).handle({
            initial: { target: "Idle" },
            states: {
              Idle: { on: { Load: { target: "Loading", data: ({ event }) => ({ id: event.id, notes: 0 }) } } },
              Loading: {
                invoke: [
                  { src: "first", onDone: { stay: true }, onFailure: { stay: true } },
                  {
                    src: "second",
                    input: (): string => {
                      started.push("second")
                      throw new Error("no input")
                    }
                  },
                  { src: "third", onDone: { stay: true }, onFailure: { stay: true } }
                ]
              }
            }
          })
          yield* run(machine, {}, ({ driver, send, storage, stored }) =>
            Effect.gen(function*() {
              // The request is stored before its work starts, so it is accepted.
              assertAccepted(yield* send(Event.Load({ id: "a" })))
              assert.deepStrictEqual(storage.history.map(({ status }) => status._tag), ["Active", "Failed"])
              assert.strictEqual(pathOf(stored()), "Loading")
              assert.deepStrictEqual(stored()?.origin, { _tag: "Invocation", path: "Loading", id: "second" })
              assert.deepStrictEqual(stored()?.status, { _tag: "Failed", failure: "Error: no input" })
              assert.deepStrictEqual(started, ["second"])
              assert.deepStrictEqual(work.runs.map(({ input, stopped }) => [input, stopped]), [["first", true]])
              yield* settle
              assert.strictEqual(keptAlive(driver), 0)
              assertRejected(yield* send(Event.Note()), "MachineFailed")
            }))
        }))

      it.effect("is stored again when storing the failure of a start fails", () =>
        Effect.gen(function*() {
          const work = makeWork()
          let inputs = 0
          const machine = Machine.make({
            id: "Unstartable",
            root: loaderRoot,
            events: Events,
            effects: { load: (_: string) => work.run("load") }
          }).handle({
            initial: { target: "Idle" },
            states: {
              Idle: { on: { Load: { target: "Loading", data: ({ event }) => ({ id: event.id, notes: 0 }) } } },
              Loading: {
                invoke: {
                  src: "load",
                  input: (): string => {
                    inputs += 1
                    throw new Error("no input")
                  },
                  onDone: { stay: true },
                  onFailure: { stay: true }
                }
              }
            }
          })
          yield* run(machine, {}, ({ send, storage, stored }) =>
            Effect.gen(function*() {
              storage.onCommit(() => {
                if (storage.commitAttempts === 2 || storage.commitAttempts === 3) storage.failNextCommit()
              })
              assertAccepted(yield* send(Event.Load({ id: "a" })))
              assert.strictEqual(stored()?.status._tag, "Active")
              yield* TestClock.adjust("10 seconds")
              yield* until(() => stored()?.status._tag === "Failed")
              assert.strictEqual(storage.commitAttempts, 4)
              assert.strictEqual(inputs, 3)
              assertRejected(yield* send(Event.Note()), "MachineFailed")
            }))
        }))
    })

    describe("host capabilities", () => {
      const refused: Record<string, (context: any) => Effect.Effect<unknown, any, any>> = {
        "children.spawn": ({ children }) => children.spawn(UnsupportedChild)
      }
      // They act on the child entities of the machine, as `Machine.sendTo` and
      // `Machine.stopChild` do, and ignore a child that does not run.
      const ignored: Record<string, (context: any) => Effect.Effect<unknown, any, any>> = {
        "children.sendTo": ({ children }) => children.sendTo(UnsupportedChild, { _tag: "Note" }),
        "children.stop": ({ children }) => children.stop(UnsupportedChild)
      }
      const makeCapable = (use: (context: any) => Effect.Effect<unknown, any, any>, contexts: Array<any>) =>
        Machine.make({
          id: "Capable",
          root: Machine.state({ states: { Working: {}, Done: {} } }),
          events: Events,
          parent: Machine.optionalParent(Machine.events({ Report: {} })),
          effects: { use: (context: any) => use(context) as Effect.Effect<void> }
        }).handle({
          initial: { target: "Working" },
          states: {
            Working: {
              on: { Note: { stay: true } },
              invoke: {
                src: "use",
                input: (context) => {
                  contexts.push(context)
                  return context
                },
                onDone: { target: "Done" }
              }
            },
            Done: {}
          }
        })
      for (const [operation, use] of Object.entries(refused)) {
        it.effect(`fails a machine whose work uses ${operation}`, () =>
          Effect.gen(function*() {
            yield* run(makeCapable(use, []), {}, ({ send, stored }) =>
              Effect.gen(function*() {
                assertAccepted(yield* send(Event.Note()))
                yield* until(() => stored()?.status._tag === "Failed")
                assert.deepStrictEqual(stored()?.status, {
                  _tag: "Failed",
                  failure: `${operation} is process-local and is not supported`
                })
              }))
          }))
      }
      for (const [operation, use] of Object.entries(ignored)) {
        it.effect(`ignores ${operation} of work for a child that does not run`, () =>
          Effect.gen(function*() {
            yield* run(makeCapable(use, []), {}, ({ send, stored }) =>
              Effect.gen(function*() {
                assertAccepted(yield* send(Event.Note()))
                yield* until(() => pathOf(stored()) === "Done")
                assert.strictEqual(stored()?.status._tag, "Active")
              }))
          }))
      }
      it.effect("names the machine, and has no parent", () =>
        Effect.gen(function*() {
          const contexts: Array<any> = []
          yield* run(makeCapable(() => Effect.void, contexts), {}, ({ send, stored }) =>
            Effect.gen(function*() {
              assertAccepted(yield* send(Event.Note()))
              yield* until(() => pathOf(stored()) === "Done")
              assert.strictEqual(contexts[0].self.id, "Capable")
              assert.strictEqual(contexts[0].parent, undefined)
            }))
        }))
      it.effect("fails a machine whose work needs the runtime of a local process", () =>
        Effect.gen(function*() {
          // A child address names a process, which only a local host runs.
          yield* run(makeCapable(() => Machine.stopChild(Machine.childAddress("worker")), []), {}, ({ send, stored }) =>
            Effect.gen(function*() {
              assertAccepted(yield* send(Event.Note()))
              yield* until(() =>
                stored()?.status._tag === "Failed"
              )
              const status = stored()!.status
              assert(status._tag === "Failed")
              assert.strictEqual(status.failure, "stopChild is process-local and is not supported")
            }))
        }))
      it.effect("gives each run a scope that closes with it", () =>
        Effect.gen(function*() {
          const released: Array<string> = []
          yield* run(
            makeCapable(
              () => Effect.acquireRelease(Effect.void, () => Effect.sync(() => released.push("released"))),
              []
            ),
            {},
            ({ send, stored }) =>
              Effect.gen(function*() {
                assertAccepted(yield* send(Event.Note()))
                yield* until(() => pathOf(stored()) === "Done")
                assert.deepStrictEqual(released, ["released"])
              })
          )
        }))
      it.effect("traces hosted work like the local runtime, with the entity as its process", () =>
        Effect.gen(function*() {
          const work = makeWork()
          const spans: Array<Tracer.Span> = []
          const tracer = Tracer.make({
            span(options) {
              const span = new Tracer.NativeSpan(options)
              spans.push(span)
              return span
            }
          })
          yield* run(makeLoader(work), {}, ({ send, stored }) =>
            Effect.gen(function*() {
              assertAccepted(yield* send(Event.Load({ id: "a" })))
              yield* succeed(work.runs[0], "document a")
              yield* until(() => pathOf(stored()) === "Loaded")
            })).pipe(Effect.withTracer(tracer))
          const invoked = spans.filter(({ name }) => name === "Machine.invoke")
          assert.deepStrictEqual(invoked.map(({ attributes }) => Object.fromEntries(attributes)), [{
            "machine.id": "Loader",
            "machine.state.path": "Loading",
            "machine.invoke.id": "load",
            "machine.invoke.source": "load",
            "machine.invoke.kind": "Effect",
            "entity.type": "Worker",
            "entity.id": "worker-1"
          }])
        }))
    })

    describe("invocation that ended without leaving its state", () => {
      const makeStaying = (work: Work) =>
        Machine.make({
          id: "Staying",
          root: loaderRoot,
          events: Events,
          effects: { first: work.run("first"), second: work.run("second"), update: work.run("update") }
        }).handle({
          initial: { target: "Idle" },
          states: {
            Idle: { on: { Load: { target: "Loading", data: ({ event }) => ({ id: event.id, notes: 0 }) } } },
            Loading: {
              invoke: [
                { src: "first", onDone: { stay: true }, onFailure: { stay: true } },
                {
                  src: "update",
                  onDone: { update: { Loading: ({ state }) => ({ ...state, notes: state.notes + 10 }) } },
                  onFailure: { stay: true }
                },
                {
                  src: "second",
                  onDone: { target: "Loaded", data: ({ output }) => ({ result: output }) },
                  onFailure: { stay: true }
                }
              ],
              on: {
                Cancel: { target: "Idle" },
                Reload: { target: "Loading", reenter: true, data: ({ state }) => state }
              }
            },
            Loaded: {},
            Failed: {}
          }
        })
      const inputsOf = (work: Work) => work.runs.map(({ input }) => input)

      it.effect("does not run again after a reload, until its state is entered again", () =>
        Effect.gen(function*() {
          const work = makeWork()
          const storage = makeTestStorage()
          const messages = yield* makeMessages
          const machine = makeStaying(work)
          const first = yield* startRunner(machine, storage, messages)
          assertAccepted(yield* first.send(Event.Load({ id: "a" })))
          assert.deepStrictEqual(inputsOf(work), ["first", "update", "second"])
          yield* succeed(work.runs[0], "done")
          yield* Deferred.fail(work.runs[1]!.result, { reason: "handled" })
          yield* until(() => storage.commits === 3)
          assert.deepStrictEqual(first.stored()?.status, {
            _tag: "Active",
            invocations: { Loading: { first: { _tag: "Settled" }, update: { _tag: "Settled" } } }
          })
          yield* first.stop
          assert.isTrue(work.runs[2]!.stopped)

          const second = yield* startRunner(machine, storage, messages)
          yield* until(() => work.runs.length === 4)
          yield* settle
          assert.deepStrictEqual(inputsOf(work).slice(3), ["second"])
          assertAccepted(yield* second.send(Event.Reload()))
          assert.deepStrictEqual(inputsOf(work).slice(4), ["first", "update", "second"])
          assert.deepStrictEqual(second.stored()?.status, active)
          yield* succeed(work.runs[5], "updated")
          yield* until(() => storage.commits === 5)
          assert.deepStrictEqual(leafOf(second.stored())?.value, { _tag: "Loading", id: "a", notes: 10 })
          assertAccepted(yield* second.send(Event.Cancel()))
          assert.deepStrictEqual(second.stored()?.status, active)
          assertAccepted(yield* second.send(Event.Load({ id: "b" })))
          assert.deepStrictEqual(inputsOf(work).slice(7), ["first", "update", "second"])
        }))

      it.effect("releases the keep-alive when nothing is left to run", () =>
        Effect.gen(function*() {
          const work = makeWork()
          const machine = Machine.make({
            id: "Resting",
            root: loaderRoot,
            events: Events,
            effects: { load: work.run("load") }
          }).handle({
            initial: { target: "Idle" },
            states: {
              Idle: { on: { Load: { target: "Loading", data: ({ event }) => ({ id: event.id, notes: 0 }) } } },
              Loading: { invoke: { src: "load", onDone: { stay: true }, onFailure: { stay: true } } }
            }
          })
          yield* run(machine, {}, ({ driver, send, stored }) =>
            Effect.gen(function*() {
              assertAccepted(yield* send(Event.Load({ id: "a" })))
              assert.strictEqual(keptAlive(driver), 1)
              yield* succeed(work.runs[0], "done")
              yield* until(() => stored()?.revision === 2)
              yield* settle
              assert.strictEqual(pathOf(stored()), "Loading")
              assert.strictEqual(keptAlive(driver), 0)
            }))
        }))

      it.effect("rejects a checkpoint that settles an invocation of an inactive state", () =>
        Effect.gen(function*() {
          const work = makeWork()
          yield* run(makeLoader(work), {}, ({ key, send, storage, stored }) =>
            Effect.gen(function*() {
              storage.entries.set(key, {
                definitionId: "Loader",
                version: "1",
                revision: 1,
                origin: request(Snowflake.Snowflake(0)),
                snapshot: { version: 2, _tag: "MachineSnapshot", active: [{ path: "" }, { path: "Idle" }] },
                status: { _tag: "Active", invocations: { Loading: { load: { _tag: "Settled" } } } }
              })
              assertRejected(yield* send(Event.Note()), "InvalidCheckpoint")
              assert.strictEqual(stored()?.revision, 1)
              for (
                const status of [
                  undefined,
                  { _tag: "Other" },
                  { _tag: "Failed" },
                  { _tag: "Active" },
                  { _tag: "Active", settled: [] },
                  { _tag: "Active", invocations: [] },
                  { _tag: "Active", invocations: { Idle: [] } },
                  { _tag: "Active", invocations: { Idle: { load: "Settled" } } },
                  { _tag: "Active", invocations: { Idle: { load: { _tag: "Other" } } } }
                ]
              ) {
                storage.entries.set(key, { ...stored()!, status: status as never })
                assertRejected(yield* send(Event.Note()), "InvalidCheckpoint")
              }
              storage.entries.set(key, { ...stored()!, status: active })
              assertAccepted(yield* send(Event.Note()))
            }))
        }))
    })

    /** Counts how often a runner that reads through the overrides is delivered a keep-alive request. */
    const recordKeepAlive = (messages: Effect.Success<typeof makeMessages>) => {
      let deliveries = 0
      const overrides: Partial<MessageStorage.MessageStorage["Service"]> = {
        unprocessedMessages: (shardIds, options) =>
          Effect.tap(messages.storage.unprocessedMessages(shardIds, options), (read) =>
            Effect.sync(() => {
              deliveries += read.filter(({ envelope }) =>
                envelope._tag === "Request" && envelope.tag === "Cluster/Entity/keepAlive"
              ).length
            }))
      }
      return { count: () => deliveries, overrides }
    }

    describe("keep-alive", () => {
      it.effect("keeps an idle entity while its work runs, and lets it go afterwards", () =>
        Effect.gen(function*() {
          const work = makeWork()
          yield* run(makeLoader(work), { idle: 0 }, ({ driver, send, sharding, stored }) =>
            Effect.gen(function*() {
              assertAccepted(yield* send(Event.Load({ id: "a" })))
              yield* TestClock.adjust("30 seconds")
              yield* settle
              assert.strictEqual(yield* sharding.activeEntityCount, 1)
              assert.isFalse(work.runs[0]!.stopped)
              yield* succeed(work.runs[0], "document a")
              yield* until(() => pathOf(stored()) === "Loaded")
              yield* settle
              assert.strictEqual(keptAlive(driver), 0)
              yield* TestClock.adjust("30 seconds")
              yield* settle
              assert.strictEqual(yield* sharding.activeEntityCount, 0)
              assert.strictEqual(work.runs.length, 1)
            }))
        }))

      it.effect("lets an entity go that never had work", () =>
        Effect.gen(function*() {
          const work = makeWork()
          yield* run(makeLoader(work), { idle: 0 }, ({ driver, send, sharding }) =>
            Effect.gen(function*() {
              assertAccepted(yield* send(Event.Note()))
              assert.strictEqual(keptAlive(driver), 0)
              yield* TestClock.adjust("30 seconds")
              yield* settle
              assert.strictEqual(yield* sharding.activeEntityCount, 0)
            }))
        }))

      it.effect("follows work that ends and starts again at once", () =>
        Effect.gen(function*() {
          const work = makeWork()
          yield* run(makeLoader(work), { idle: 0 }, ({ driver, send, sharding }) =>
            Effect.gen(function*() {
              assertAccepted(yield* send(Event.Load({ id: "a" })))
              for (let round = 0; round < 5; round++) {
                assertAccepted(yield* send(Event.Cancel()))
                assertAccepted(yield* send(Event.Load({ id: "a" })))
                yield* settle
                assert.strictEqual(keptAlive(driver), 1)
              }
              yield* TestClock.adjust("30 seconds")
              yield* settle
              assert.strictEqual(yield* sharding.activeEntityCount, 1)
              assert.isFalse(work.runs.at(-1)!.stopped)
            }))
        }))

      it.effect("follows work that ends and starts again in requests sent together", () =>
        Effect.gen(function*() {
          const work = makeWork()
          yield* run(makeLoader(work), { idle: 0 }, ({ driver, send, sharding }) =>
            Effect.gen(function*() {
              assertAccepted(yield* send(Event.Load({ id: "a" })))
              for (let round = 0; round < 5; round++) {
                yield* settle
                const [cancelled, loaded] = yield* Effect.all([
                  send(Event.Cancel()),
                  send(Event.Load({ id: "a" }))
                ], { concurrency: "unbounded" })
                assertAccepted(cancelled)
                assertAccepted(loaded)
                yield* settle
                assert.strictEqual(keptAlive(driver), 1)
              }
              yield* TestClock.adjust("30 seconds")
              yield* settle
              assert.strictEqual(yield* sharding.activeEntityCount, 1)
              assert.strictEqual(work.runs.length, 6)
              assert.isFalse(work.runs.at(-1)!.stopped)
            }))
        }))

      it.effect("revives an entity that ended before it held a request for a caller that gave up", () =>
        Effect.gen(function*() {
          const work = makeWork()
          const storage = makeTestStorage()
          const messages = yield* makeMessages
          const machine = makeLoader(work)
          let saveKeepAlive: Effect.Effect<void> = Effect.never
          const first = yield* startRunner(machine, storage, messages, {
            overrides: {
              saveRequest: (message) =>
                Effect.andThen(
                  message.envelope.tag === "Cluster/Entity/keepAlive"
                    ? Effect.suspend(() => saveKeepAlive)
                    : Effect.void,
                  messages.storage.saveRequest(message)
                )
            }
          })
          const caller = yield* Effect.forkChild(first.send(Event.Load({ id: "a" })), { startImmediately: true })
          yield* settle
          yield* Fiber.interrupt(caller)
          yield* settle
          // Its step is stored, and it is answered.
          assert.strictEqual(pathOf(first.stored()), "Loading")
          assert.strictEqual(messages.driver.unprocessed.size, 0)
          saveKeepAlive = Effect.void
          yield* first.stop
          assert.strictEqual(keptAlive(messages.driver), 1)
          yield* startRunner(machine, storage, messages)
          yield* until(() => work.runs.length === 2)
        }))

      it.effect(
        "still revives an entity whose work has run for longer than a claim lasts",
        () =>
          Effect.gen(function*() {
            const work = makeWork()
            const storage = makeTestStorage()
            const messages = yield* makeMessages
            const machine = makeLoader(work)
            const delivered = recordKeepAlive(messages)
            const first = yield* startRunner(machine, storage, messages, { idle: 0, overrides: delivered.overrides })
            assertAccepted(yield* first.send(Event.Load({ id: "a" })))
            for (let minutes = 0; minutes < 35; minutes++) {
              yield* TestClock.adjust("1 minute")
              yield* settle
              assertHeld(messages.driver)
            }
            // Once, and again after each claim expired.
            assert.strictEqual(delivered.count(), 4)
            assert.strictEqual(yield* first.sharding.activeEntityCount, 1)
            assert.strictEqual(work.runs.length, 1)
            assert.isFalse(work.runs[0]!.stopped)
            const before = first.stored()
            yield* first.stop
            assertHeld(messages.driver)

            const second = yield* startRunner(machine, storage, messages, { idle: 0 })
            yield* until(() => work.runs.length === 2)
            assert.strictEqual(second.stored(), before)
            yield* succeed(work.runs[1], "document a")
            yield* until(() => pathOf(second.stored()) === "Loaded")
            yield* settle
            assert.strictEqual(keptAlive(messages.driver), 0)
            yield* TestClock.adjust("30 seconds")
            yield* settle
            assert.strictEqual(yield* second.sharding.activeEntityCount, 0)
          }),
        30000
      )

      it.effect("releases a request left by a deployment that invoked effects", () =>
        Effect.gen(function*() {
          const work = makeWork()
          const storage = makeTestStorage()
          const messages = yield* makeMessages
          const first = yield* startRunner(makeLoader(work), storage, messages)
          assertAccepted(yield* first.send(Event.Load({ id: "a" })))
          yield* first.stop
          assert.strictEqual(keptAlive(messages.driver), 1)
          const second = yield* startRunner(
            Machine.make({ id: "Loader", root: loaderRoot, events: Events }).handle({
              initial: { target: "Idle" },
              states: {}
            }),
            storage,
            messages,
            { idle: 0 }
          )
          yield* until(() => keptAlive(messages.driver) === 0)
          yield* TestClock.adjust("30 seconds")
          yield* settle
          assert.strictEqual(yield* second.sharding.activeEntityCount, 0)
          assert.strictEqual(work.runs.length, 1)
        }))
    })

    describe("recovery", () => {
      it.effect("runs the work again on another runner, without a request", () =>
        Effect.gen(function*() {
          const work = makeWork()
          const inputs: Array<unknown> = []
          const storage = makeTestStorage()
          const messages = yield* makeMessages
          const machine = makeLoader(work, inputs)
          const first = yield* startRunner(machine, storage, messages)
          assertAccepted(yield* first.send(Event.Load({ id: "a" })))
          assertAccepted(yield* first.send(Event.Note()))
          const before = first.stored()
          const sent = messages.driver.journal.length
          yield* first.stop
          // Ending the runner stops the work, and neither stores nor answers anything.
          assert.isTrue(work.runs[0]!.stopped)
          assert.strictEqual(first.stored(), before)
          assert.strictEqual(messages.driver.journal.length, sent)
          assert.strictEqual(keptAlive(messages.driver), 1)
          yield* succeed(work.runs[0], "lost")
          yield* settle
          assert.strictEqual(first.stored(), before)

          const second = yield* startRunner(machine, storage, messages)
          yield* until(() => work.runs.length === 2)
          assert.deepStrictEqual(work.runs.map(({ input }) => input), ["a", "a"])
          assert.deepStrictEqual(inputs, ["Load", Machine.InitialEvent._tag])
          assert.strictEqual(second.stored(), before)
          yield* succeed(work.runs[1], "document a")
          yield* until(() => pathOf(second.stored()) === "Loaded")
          yield* settle
          assert.deepStrictEqual(leafOf(second.stored())?.value, { _tag: "Loaded", result: "document a" })
          assert.strictEqual(storage.commits, 3)
          assert.strictEqual(work.runs.length, 2)
          assert.strictEqual(keptAlive(messages.driver), 0)
          // Every client request was sent to the first runner.
          assert.strictEqual(
            messages.driver.journal.filter((envelope) => envelope._tag === "Request" && envelope.tag === "send").length,
            2
          )
        }))

      it.effect("starts the work of two regions in the order of the resolver", () =>
        Effect.gen(function*() {
          const order: Array<string> = []
          const storage = makeTestStorage()
          const messages = yield* makeMessages
          const machine = makeParallel(order)
          const first = yield* startRunner(machine, storage, messages)
          assertAccepted(yield* first.send({ _tag: "Go" }))
          yield* until(() => storage.commits === 2)
          yield* first.stop
          order.length = 0
          yield* startRunner(machine, storage, messages)
          yield* until(() => order.length === 2)
          yield* settle
          assert.deepStrictEqual(order, ["right region", "right busy"])
        }))

      it.effect("wakes up once storage answers again", () =>
        Effect.gen(function*() {
          const work = makeWork()
          const storage = makeTestStorage()
          const messages = yield* makeMessages
          const machine = makeLoader(work)
          const first = yield* startRunner(machine, storage, messages)
          assertAccepted(yield* first.send(Event.Load({ id: "a" })))
          yield* first.stop
          storage.failNextLoad()
          const loads = storage.loads
          const second = yield* startRunner(machine, storage, messages)
          yield* until(() => storage.loads === loads + 1)
          yield* settle
          assert.strictEqual(work.runs.length, 1)
          storage.failNextLoad()
          yield* TestClock.adjust("10 seconds")
          yield* until(() => work.runs.length === 2)
          assert.strictEqual(storage.loads, loads + 3)
          assert.strictEqual(pathOf(second.stored()), "Loading")
        }))

      it.effect("recovers when a passivated entity receives a request", () =>
        Effect.gen(function*() {
          const work = makeWork()
          const inputs: Array<unknown> = []
          yield* run(makeLoader(work, inputs), { idle: 0 }, ({ key, send, storage, stored }) =>
            Effect.gen(function*() {
              assertAccepted(yield* send(Event.Note()))
              yield* TestClock.adjust("30 seconds")
              yield* settle
              // A deployment restored another checkpoint while the entity was passive.
              storage.write(key, (checkpoint) => ({
                ...checkpoint,
                snapshot: {
                  ...checkpoint.snapshot,
                  active: [{ path: "" }, { path: "Loading", value: { _tag: "Loading", id: "b", notes: 3 } }]
                }
              }))
              assertAccepted(yield* send(Event.Note()))
              assert.deepStrictEqual(work.runs.map(({ input }) => input), ["b"])
              assert.deepStrictEqual(inputs, [Machine.InitialEvent._tag])
              assert.deepStrictEqual(leafOf(stored())?.value, { _tag: "Loading", id: "b", notes: 4 })
            }))
        }))

      it.effect("runs nothing and keeps its keep-alive when it cannot read the checkpoint", () =>
        Effect.gen(function*() {
          const work = makeWork()
          const storage = makeTestStorage()
          const messages = yield* makeMessages
          const machine = makeLoader(work)
          const first = yield* startRunner(machine, storage, messages)
          assertAccepted(yield* first.send(Event.Load({ id: "a" })))
          yield* first.stop
          storage.write(storageKey("Worker", "worker-1"), (checkpoint) => ({ ...checkpoint, version: "2" }))
          const second = yield* startRunner(machine, storage, messages)
          yield* settle
          assert.strictEqual(work.runs.length, 1)
          assertRejected(yield* second.send(Event.Note()), "VersionMismatch")
          yield* settle
          assert.strictEqual(keptAlive(messages.driver), 1)
          const loads = storage.loads
          yield* TestClock.adjust("1 minute")
          assert.strictEqual(storage.loads, loads)
          assert.strictEqual(second.stored()?.version, "2")
          yield* second.stop

          storage.write(storageKey("Worker", "worker-1"), (checkpoint) => ({ ...checkpoint, version: "1" }))
          yield* startRunner(machine, storage, messages)
          yield* until(() => work.runs.length === 2)
        }))

      it.effect("starts no work for a state that was only planned", () =>
        Effect.gen(function*() {
          const work = makeWork()
          yield* run(makeLoader(work), {}, ({ driver, send, storage, stored }) =>
            Effect.gen(function*() {
              storage.failNextCommit()
              assertRejected(yield* send(Event.Load({ id: "a" })), "PersistenceFailure")
              yield* settle
              assert.strictEqual(work.runs.length, 0)
              assert.strictEqual(keptAlive(driver), 0)
              assert.strictEqual(stored(), undefined)
              assertAccepted(yield* send(Event.Load({ id: "b" })))
              assert.deepStrictEqual(work.runs.map(({ input }) => input), ["b"])
            }))
        }))

      it.effect("starts no work for a transaction that failed after its commit", () =>
        Effect.gen(function*() {
          const work = makeWork()
          const storage = makeTestStorage()
          let failNext = true
          const transaction = rollingBack(storage, [])
          const withTransaction: typeof transaction = (effect) =>
            transaction(Effect.tap(effect, () =>
              Effect.sync(() => {
                if (!failNext || storage.commits === 0) return
                failNext = false
                throw new Error("commit unavailable")
              })))
          yield* run(makeLoader(work), { storage, withTransaction }, ({ driver, send, stored }) =>
            Effect.gen(function*() {
              assertRejected(yield* send(Event.Load({ id: "a" })), "PersistenceFailure")
              yield* settle
              assert.strictEqual(work.runs.length, 0)
              assert.strictEqual(keptAlive(driver), 0)
              assert.strictEqual(stored(), undefined)
            }))
        }))

      it.effect("starts the work of a step whose acknowledgement was lost", () =>
        Effect.gen(function*() {
          const work = makeWork()
          const inputs: Array<unknown> = []
          const storage = makeTestStorage()
          let failNext = true
          const withTransaction: MessageStorage.MessageStorage["Service"]["withTransaction"] = (effect) =>
            Effect.tap(Effect.provideService(effect, MessageStorage.MemoryTransaction, true), () =>
              Effect.sync(() => {
                if (!failNext || storage.commits === 0) return
                failNext = false
                throw new Error("acknowledgement lost")
              }))
          yield* run(makeLoader(work, inputs), { storage, withTransaction }, ({ driver, send, stored }) =>
            Effect.gen(function*() {
              assertAccepted(yield* send(Event.Load({ id: "a" })))
              yield* until(() =>
                work.runs.length === 1
              )
              yield* until(() => keptAlive(driver) === 1)
              assert.strictEqual(pathOf(stored()), "Loading")
              assert.deepStrictEqual(inputs, [Machine.InitialEvent._tag])
            }))
        }))

      it.effect("keeps running work when a reload finds the state it was started from", () =>
        Effect.gen(function*() {
          const work = makeWork()
          yield* run(makeLoader(work), {}, ({ driver, send, storage, stored }) =>
            Effect.gen(function*() {
              assertAccepted(yield* send(Event.Load({ id: "a" })))
              storage.failNextCommit()
              const loads = storage.loads
              assertRejected(yield* send(Event.Cancel()), "PersistenceFailure")
              // The rejection asked first, and recovery loaded afterwards.
              yield* until(() => storage.loads === loads + 2)
              yield* settle
              assert.strictEqual(work.runs.length, 1)
              assert.isFalse(work.runs[0]!.stopped)
              assert.strictEqual(keptAlive(driver), 1)
              yield* succeed(work.runs[0], "document a")
              yield* until(() => pathOf(stored()) === "Loaded")
              assert.strictEqual(storage.loads, loads + 2)
            }))
        }))

      it.effect("restarts the work from the state another instance stored", () =>
        Effect.gen(function*() {
          const work = makeWork()
          const inputs: Array<unknown> = []
          yield* run(makeLoader(work, inputs), {}, ({ key, send, storage, stored }) =>
            Effect.gen(function*() {
              assertAccepted(yield* send(Event.Load({ id: "a" })))
              storage.write(key, (checkpoint) => ({
                ...checkpoint,
                snapshot: {
                  ...checkpoint.snapshot,
                  active: [{ path: "" }, { path: "Loading", value: { _tag: "Loading", id: "other", notes: 7 } }]
                }
              }))
              // The result belongs to a state that storage no longer holds.
              yield* succeed(work.runs[0], "stale")
              yield* until(() => work.runs.length === 2)
              assert.deepStrictEqual(work.runs.map(({ input }) => input), ["a", "other"])
              assert.deepStrictEqual(inputs, ["Load", Machine.InitialEvent._tag])
              assert.strictEqual(stored()?.revision, 2)
              assertAccepted(yield* send(Event.Note()))
              assert.deepStrictEqual(leafOf(stored())?.value, { _tag: "Loading", id: "other", notes: 8 })
              yield* succeed(work.runs[1], "fresh")
              yield* until(() => pathOf(stored()) === "Loaded")
              yield* TestClock.adjust("1 minute")
              assert.deepStrictEqual(leafOf(stored())?.value, { _tag: "Loaded", result: "fresh" })
              assert.strictEqual(stored()?.revision, 4)
            }))
        }))

      it.effect("does not fail a state that another instance stored", () =>
        Effect.gen(function*() {
          const work = makeWork()
          yield* run(makeLoader(work), {}, ({ key, send, storage, stored }) =>
            Effect.gen(function*() {
              assertAccepted(yield* send(Event.Load({ id: "a" })))
              storage.write(key, (checkpoint) => checkpoint)
              yield* Deferred.die(work.runs[0]!.result, new Error("broken"))
              yield* until(() => work.runs.length === 2)
              assert.strictEqual(storage.commitAttempts, 1)
              assert.strictEqual(stored()?.revision, 2)
              assert.deepStrictEqual(stored()?.status, active)
              yield* succeed(work.runs[1], "document a")
              yield* until(() => pathOf(stored()) === "Loaded")
              yield* TestClock.adjust("1 minute")
              assert.strictEqual(stored()?.revision, 3)
            }))
        }))

      it.effect("restarts the work when a request finds the state of another instance", () =>
        Effect.gen(function*() {
          const work = makeWork()
          yield* run(makeLoader(work), {}, ({ key, send, storage, stored }) =>
            Effect.gen(function*() {
              assertAccepted(yield* send(Event.Load({ id: "a" })))
              storage.write(key, (checkpoint) => ({
                ...checkpoint,
                snapshot: {
                  ...checkpoint.snapshot,
                  active: [{ path: "" }, { path: "Loading", value: { _tag: "Loading", id: "other", notes: 7 } }]
                }
              }))
              assertAccepted(yield* send(Event.Note()))
              assert.deepStrictEqual(leafOf(stored())?.value, { _tag: "Loading", id: "other", notes: 8 })
              assert.deepStrictEqual(work.runs.map(({ input, stopped }) => [input, stopped]), [
                ["a", true],
                ["other", false]
              ])
              assert.strictEqual(stored()?.revision, 3)
            }))
        }))

      it.effect("stops the work when another instance stored the machine as failed", () =>
        Effect.gen(function*() {
          const work = makeWork()
          yield* run(makeLoader(work), {}, ({ driver, key, send, storage }) =>
            Effect.gen(function*() {
              assertAccepted(yield* send(Event.Load({ id: "a" })))
              storage.write(key, (checkpoint) => ({ ...checkpoint, status: { _tag: "Failed", failure: "elsewhere" } }))
              assertRejected(yield* send(Event.Note()), "MachineFailed")
              assert.isTrue(work.runs[0]!.stopped)
              yield* settle
              assert.strictEqual(keptAlive(driver), 0)
            }))
        }))
    })

    describe("storage failures while a result is stored", () => {
      it.effect("retries the commit without failing the machine", () =>
        Effect.gen(function*() {
          const work = makeWork()
          yield* run(makeLoader(work), {}, ({ send, storage, stored }) =>
            Effect.gen(function*() {
              assertAccepted(yield* send(Event.Load({ id: "a" })))
              let failures = 4
              storage.onCommit(() => {
                if (failures-- > 0) storage.failNextCommit()
              })
              yield* succeed(work.runs[0], "document a")
              yield* until(() => storage.commitAttempts === 2)
              yield* settle
              assert.strictEqual(pathOf(stored()), "Loading")
              // Recovery loaded once, and the failed commit asked for nothing else.
              assert.strictEqual(storage.loads, 2)
              // Requests are applied in between, and nothing is lost.
              storage.onCommit(() => {})
              assertAccepted(yield* send(Event.Note()))
              assert.deepStrictEqual(leafOf(stored())?.value, { _tag: "Loading", id: "a", notes: 1 })
              storage.onCommit(() => {
                if (failures-- > 0) storage.failNextCommit()
              })
              yield* TestClock.adjust("1 minute")
              yield* until(() => pathOf(stored()) === "Loaded")
              assert.deepStrictEqual(leafOf(stored())?.value, { _tag: "Loaded", result: "document a" })
              assert.strictEqual(stored()?.revision, 3)
              assert.strictEqual(work.runs.length, 1)
              assert.deepStrictEqual(storage.history.map(({ status }) => status._tag), ["Active", "Active", "Active"])
            }))
        }))

      it.effect("retries until the state can be loaded again", () =>
        Effect.gen(function*() {
          const work = makeWork()
          yield* run(makeLoader(work), {}, ({ send, storage, stored }) =>
            Effect.gen(function*() {
              assertAccepted(yield* send(Event.Load({ id: "a" })))
              storage.failNextCommit()
              storage.failNextLoad()
              yield* succeed(work.runs[0], "document a")
              yield* TestClock.adjust("10 seconds")
              yield* until(() => pathOf(stored()) === "Loaded")
              assert.strictEqual(work.runs.length, 1)
              assert.strictEqual(stored()?.revision, 2)
            }))
        }))

      it.effect("retries storing a failure", () =>
        Effect.gen(function*() {
          const work = makeWork()
          yield* run(makeLoader(work), {}, ({ send, storage, stored }) =>
            Effect.gen(function*() {
              assertAccepted(yield* send(Event.Load({ id: "a" })))
              storage.failNextCommit()
              yield* Deferred.die(work.runs[0]!.result, new Error("broken"))
              yield* until(() => storage.commitAttempts === 2)
              yield* settle
              assert.strictEqual(stored()?.status._tag, "Active")
              yield* TestClock.adjust("10 seconds")
              yield* until(() => stored()?.status._tag === "Failed")
              assert.strictEqual(work.runs.length, 1)
            }))
        }))

      it.effect("does not apply a result twice when the acknowledgement of its commit is lost", () =>
        Effect.gen(function*() {
          const work = makeWork()
          const storage = makeTestStorage()
          let failNext = true
          const withTransaction: MessageStorage.MessageStorage["Service"]["withTransaction"] = (effect) =>
            Effect.tap(Effect.provideService(effect, MessageStorage.MemoryTransaction, true), () =>
              Effect.sync(() => {
                if (!failNext || storage.commits < 2) return
                failNext = false
                throw new Error("acknowledgement lost")
              }))
          yield* run(
            makeLoader(work),
            { storage, withTransaction },
            ({ driver, send, stored }) =>
              Effect.gen(function*() {
                assertAccepted(yield* send(Event.Load({ id: "a" })))
                yield* succeed(work.runs[0], "document a")
                yield* until(() => pathOf(stored()) === "Loaded")
                yield* TestClock.adjust("1 minute")
                yield* settle
                assert.strictEqual(storage.commitAttempts, 2)
                assert.strictEqual(stored()?.revision, 2)
                assert.strictEqual(work.runs.length, 1)
                assert.strictEqual(keptAlive(driver), 0)
              })
          )
        }))

      it.effect("retries a commit that storage mistakes for a duplicate", () =>
        Effect.gen(function*() {
          const work = makeWork()
          const storage = makeTestStorage()
          let duplicate = true
          const commit = storage.service.commit
          const confused = {
            ...storage,
            service: ClusterMachine.Storage.of({
              ...storage.service,
              commit: (address, checkpoint) => {
                if (checkpoint.origin._tag === "Invocation" && duplicate) {
                  duplicate = false
                  return Effect.succeed(ClusterMachine.CommitResult.Duplicate())
                }
                return commit(address, checkpoint)
              }
            })
          }
          yield* run(makeLoader(work), { storage: confused }, ({ send, stored }) =>
            Effect.gen(function*() {
              assertAccepted(yield* send(Event.Load({ id: "a" })))
              yield* succeed(work.runs[0], "document a")
              yield* settle
              assert.strictEqual(pathOf(stored()), "Loading")
              yield* TestClock.adjust("10 seconds")
              yield* until(() => pathOf(stored()) === "Loaded")
              assert.strictEqual(work.runs.length, 1)
            }))
        }))
    })

    describe("emissions of a result", () => {
      const makeEmitting = (work: Work) =>
        Machine.make({
          id: "Emitting",
          root: loaderRoot,
          events: Events,
          emittedEvents: Machine.emittedEventsFromSchemas(Changed),
          effects: { load: work.run("load"), side: work.run("side") }
        }).handle({
          initial: { target: "Idle" },
          states: {
            Idle: { on: { Load: { target: "Loading", data: ({ event }) => ({ id: event.id, notes: 0 }) } } },
            Loading: {
              invoke: [
                { src: "side", onDone: { stay: true }, onFailure: { stay: true } },
                {
                  src: "load",
                  onDone: {
                    branches: [{ target: "Loaded" }],
                    resolve: ({ output, select }, enqueue) => {
                      enqueue.emit(new Changed({ value: 1 }))
                      return select.target("Loaded", { data: { result: output } })
                    }
                  },
                  onFailure: { stay: true }
                }
              ]
            },
            Loaded: {},
            Failed: {}
          }
        })
      it.effect("are enqueued in its transaction, which is retried when that fails", () =>
        Effect.gen(function*() {
          const work = makeWork()
          const storage = makeTestStorage()
          const emitted: Array<unknown> = []
          const attempts: Array<boolean> = []
          yield* run(makeEmitting(work), {
            storage,
            withTransaction: rollingBack(storage, emitted),
            enqueue: (event) =>
              MessageStorage.MemoryTransaction.use((inTransaction) =>
                Effect.suspend(() => {
                  emitted.push(event)
                  attempts.push(inTransaction)
                  return attempts.length < 3 ? Effect.fail("outbox unavailable") : Effect.void
                })
              )
          }, ({ send, stored }) =>
            Effect.gen(function*() {
              assertAccepted(yield* send(Event.Load({ id: "a" })))
              yield* succeed(work.runs[1], "document a")
              yield* until(() => attempts.length === 1)
              yield* settle
              assert.strictEqual(pathOf(stored()), "Loading")
              assert.deepStrictEqual(stored()?.status, active)
              // The rolled back step stopped nothing.
              assert.isFalse(work.runs[0]!.stopped)
              yield* TestClock.adjust("10 seconds")
              yield* until(() => pathOf(stored()) === "Loaded")
              assert.deepStrictEqual(emitted, [new Changed({ value: 1 })])
              assert.deepStrictEqual(attempts, [true, true, true])
              assert.strictEqual(stored()?.revision, 2)
              assert.strictEqual(work.runs.length, 2)
              assert.isTrue(work.runs[0]!.stopped)
            }))
        }))
    })

    describe("ordering", () => {
      it.effect("applies a request that arrives while a result is stored after it", () =>
        Effect.gen(function*() {
          const work = makeWork()
          const gate = yield* Latch.make()
          yield* run(makeLoader(work), {}, ({ send, storage, stored }) =>
            Effect.gen(function*() {
              assertAccepted(yield* send(Event.Load({ id: "a" })))
              storage.holdCommits(gate.await)
              yield* succeed(work.runs[0], "document a")
              yield* settle
              const second = yield* Effect.forkChild(send(Event.Load({ id: "b" })), { startImmediately: true })
              yield* settle
              assert.strictEqual(storage.commits, 1)
              storage.holdCommits(Effect.void)
              yield* gate.open
              assertAccepted(yield* Fiber.join(second))
              assert.deepStrictEqual(storage.history.map(pathOf), ["Loading", "Loaded", "Loading"])
              assert.deepStrictEqual(storage.history.map(({ origin }) => origin._tag), [
                "Request",
                "Invocation",
                "Request"
              ])
              // The request was applied to the state the result led to.
              assert.deepStrictEqual(leafOf(stored())?.value, { _tag: "Loading", id: "b", notes: 0 })
              assert.deepStrictEqual(work.runs.map(({ input }) => input), ["a", "b"])
            }))
        }))

      it.effect("handles the result of work that ends at once in a later turn", () =>
        Effect.gen(function*() {
          const machine = Machine.make({
            id: "Immediate",
            root: loaderRoot,
            events: Events,
            effects: { load: Effect.succeed("now") }
          }).handle({
            initial: { target: "Idle" },
            states: {
              Idle: { on: { Load: { target: "Loading", data: ({ event }) => ({ id: event.id, notes: 0 }) } } },
              Loading: {
                invoke: { src: "load", onDone: { target: "Loaded", data: ({ output }) => ({ result: output }) } }
              },
              Loaded: {}
            }
          })
          yield* run(machine, {}, ({ driver, send, storage, stored }) =>
            Effect.gen(function*() {
              assertAccepted(yield* send(Event.Load({ id: "a" })))
              yield* until(() => pathOf(stored()) === "Loaded")
              assert.deepStrictEqual(storage.history.map(pathOf), ["Loading", "Loaded"])
              yield* settle
              assert.strictEqual(keptAlive(driver), 0)
            }))
        }))

      it.effect("does not start work twice for a redelivered request", () =>
        Effect.gen(function*() {
          const work = makeWork()
          yield* run(makeLoader(work), {}, ({ driver, send, storage, stored }) =>
            Effect.gen(function*() {
              assertAccepted(yield* send(Event.Load({ id: "a" })))
              const [first] = yield* sentRequestIds
              assert.deepStrictEqual(yield* redeliver(first!), { _tag: "Accepted" })
              yield* settle
              assert.strictEqual(work.runs.length, 1)
              assert.isFalse(work.runs[0]!.stopped)
              assert.strictEqual(storage.commits, 1)
              assert.strictEqual(keptAlive(driver), 1)
              yield* succeed(work.runs[0], "document a")
              yield* until(() => pathOf(stored()) === "Loaded")
              // Planned again against a state without work, and discarded again.
              assert.deepStrictEqual(yield* redeliver(first!), { _tag: "Accepted" })
              yield* settle
              assert.strictEqual(work.runs.length, 1)
              assert.strictEqual(keptAlive(driver), 0)
            }))
        }))
    })

    describe("work the host stops", () => {
      it.effect("ends with a final state, including the work of states that stay active", () =>
        Effect.gen(function*() {
          const work = makeWork()
          const machine = Machine.make({
            id: "Regions",
            root: Machine.state({
              type: "parallel",
              states: {
                left: { states: { Busy: {}, Done: { type: "final" } } },
                right: { states: { Busy: {}, Done: { type: "final" } } }
              }
            }),
            events: Events,
            effects: { left: work.run("left"), right: work.run("right"), busy: work.run("busy") }
          }).handle({
            states: {
              left: {
                invoke: { src: "left", onDone: { stay: true }, onFailure: { stay: true } },
                initial: { target: "left.Busy" },
                states: {
                  Busy: {
                    invoke: { src: "busy", onDone: { stay: true }, onFailure: { stay: true } },
                    on: { Note: { stay: true }, Finish: { target: "left.Done" } }
                  }
                }
              },
              right: {
                invoke: { src: "right", onDone: { stay: true }, onFailure: { stay: true } },
                initial: { target: "right.Busy" },
                states: { Busy: { on: { Finish: { target: "right.Done" } } } }
              }
            }
          })
          yield* run(machine, { idle: 0 }, ({ driver, send, sharding, storage, stored }) =>
            Effect.gen(function*() {
              // The first request plans the initial state, whose work starts with it.
              assertAccepted(yield* send(Event.Note()))
              assert.deepStrictEqual(work.runs.map(({ input }) => input), ["left", "right", "busy"])
              assertAccepted(yield* send(Event.Finish()))
              // The regions stay active in the final configuration.
              assert.deepStrictEqual(
                stored()?.snapshot.active.map(({ path }) => path),
                ["", "left", "left.Done", "right", "right.Done"]
              )
              assert.deepStrictEqual(work.runs.map(({ stopped }) => stopped), [true, true, true])
              yield* settle
              assert.deepStrictEqual(stored()?.status, active)
              assert.strictEqual(storage.commits, 2)
              assert.strictEqual(keptAlive(driver), 0)
              yield* TestClock.adjust("30 seconds")
              yield* settle
              assert.strictEqual(yield* sharding.activeEntityCount, 0)
              // Coming back does not start the work of a finished machine.
              assertAccepted(yield* send(Event.Note()))
              yield* settle
              assert.strictEqual(work.runs.length, 3)
              assert.strictEqual(keptAlive(driver), 0)
            }))
        }))

      it.effect("neither applies nor fails when its runner shuts down", () =>
        Effect.gen(function*() {
          const work = makeWork()
          const storage = makeTestStorage()
          const messages = yield* makeMessages
          const runner = yield* startRunner(makeLoader(work), storage, messages)
          assertAccepted(yield* runner.send(Event.Load({ id: "a" })))
          const before = runner.stored()
          yield* runner.stop
          yield* settle
          assert.isTrue(work.runs[0]!.stopped)
          assert.strictEqual(runner.stored(), before)
          assert.strictEqual(storage.commitAttempts, 1)
        }))

      it.effect("neither applies nor fails when the result arrives while the instance ends", () =>
        Effect.gen(function*() {
          const storage = makeTestStorage()
          const messages = yield* makeMessages
          let interrupted = 0
          // Work that turns its interruption into a result.
          const machine = Machine.make({
            id: "Stubborn",
            root: loaderRoot,
            events: Events,
            effects: {
              load: Effect.interruptible(Effect.never).pipe(
                Effect.onInterrupt(() => Effect.sync(() => void (interrupted += 1))),
                Effect.exit,
                Effect.as("too late"),
                Effect.uninterruptible
              )
            }
          }).handle({
            initial: { target: "Idle" },
            states: {
              Idle: { on: { Load: { target: "Loading", data: ({ event }) => ({ id: event.id, notes: 0 }) } } },
              Loading: {
                invoke: { src: "load", onDone: { target: "Loaded", data: ({ output }) => ({ result: output }) } },
                on: { Reload: { target: "Loading", reenter: true, data: ({ state }) => state } }
              },
              Loaded: {}
            }
          })
          const runner = yield* startRunner(machine, storage, messages)
          assertAccepted(yield* runner.send(Event.Load({ id: "a" })))
          assertAccepted(yield* runner.send(Event.Reload()))
          yield* settle
          assert.strictEqual(interrupted, 1)
          assert.strictEqual(pathOf(runner.stored()), "Loading")
          const before = runner.stored()
          yield* runner.stop
          yield* settle
          assert.strictEqual(interrupted, 2)
          assert.strictEqual(runner.stored(), before)
          assert.strictEqual(storage.commitAttempts, 2)
        }))

      it.effect("neither applies nor fails when its shard moves to another runner", () =>
        Effect.gen(function*() {
          const work = makeWork()
          const inputs: Array<unknown> = []
          const storage = makeTestStorage()
          const messages = yield* makeMessages
          const machine = makeLoader(work, inputs)
          // The runner stays up, and finds that its locks are gone.
          let lost = false
          const first = yield* startRunner(machine, storage, messages, {
            runnerStorage: Layer.effect(
              RunnerStorage.RunnerStorage,
              Effect.map(RunnerStorage.makeMemory, (runners) =>
                RunnerStorage.RunnerStorage.of({
                  ...runners,
                  acquire: (address, shardIds) => lost ? Effect.succeed([]) : runners.acquire(address, shardIds),
                  refresh: (address, shardIds) => lost ? Effect.succeed([]) : runners.refresh(address, shardIds)
                }))
            )
          })
          assertAccepted(yield* first.send(Event.Load({ id: "a" })))
          const before = first.stored()
          lost = true
          yield* TestClock.adjust("30 seconds")
          yield* until(() => work.runs[0]!.stopped)
          yield* settle
          assert.strictEqual(yield* first.sharding.activeEntityCount, 0)
          assert.strictEqual(first.stored(), before)
          assert.strictEqual(storage.commitAttempts, 1)
          assert.strictEqual(keptAlive(messages.driver), 1)

          const second = yield* startRunner(machine, storage, messages)
          yield* until(() => work.runs.length === 2)
          assert.deepStrictEqual(inputs, ["Load", Machine.InitialEvent._tag])
          yield* succeed(work.runs[1], "document a")
          yield* until(() => pathOf(second.stored()) === "Loaded")
          assert.strictEqual(storage.commitAttempts, 2)
        }))

      it.effect("neither applies nor fails when its entity is passivated", () =>
        Effect.gen(function*() {
          const work = makeWork()
          // Without keep-alive, an idle entity with work can be passivated.
          const storage = makeTestStorage()
          const messages = yield* makeMessages
          const isKeepAlive = (message: { readonly envelope: { readonly _tag: string; readonly tag?: string } }) =>
            message.envelope.tag === "Cluster/Entity/keepAlive"
          const runner = yield* startRunner(makeLoader(work), storage, messages, {
            idle: 0,
            overrides: {
              saveRequest: (message) =>
                isKeepAlive(message)
                  ? Effect.succeed(MessageStorage.SaveResult.Success())
                  : messages.storage.saveRequest(message)
            }
          })
          assertAccepted(yield* runner.send(Event.Load({ id: "a" })))
          const before = runner.stored()
          yield* TestClock.adjust("30 seconds")
          yield* settle
          assert.strictEqual(yield* runner.sharding.activeEntityCount, 0)
          assert.isTrue(work.runs[0]!.stopped)
          assert.strictEqual(runner.stored(), before)
          assert.strictEqual(storage.commitAttempts, 1)
        }))
    })

    describe("timers", () => {
      const TimerEvents = Machine.events({
        Wait: { seconds: Schema.Number },
        Note: {},
        Cancel: {},
        Restart: {},
        Finish: {}
      })
      const wait = (seconds: number) => ({ _tag: "Wait", seconds })
      const timerRoot = Machine.state({
        states: {
          Idle: {},
          Waiting: { fields: { seconds: Schema.Number, notes: Schema.Number } },
          Expired: {},
          Finished: { type: "final" }
        }
      })
      /** What the model code of a timer did. */
      const makeEvaluations = () => ({ events: [] as Array<unknown>, seconds: [] as Array<number> })
      type Evaluations = ReturnType<typeof makeEvaluations>
      const makeTimer = (evaluations: Evaluations = makeEvaluations()) =>
        Machine.make({
          id: "Timer",
          root: timerRoot,
          events: TimerEvents,
          timers: {
            wait: (seconds: number) => {
              evaluations.seconds.push(seconds)
              return Duration.seconds(seconds)
            }
          }
        }).handle({
          initial: { target: "Idle" },
          states: {
            Idle: { on: { Wait: { target: "Waiting", data: ({ event }) => ({ seconds: event.seconds, notes: 0 }) } } },
            Waiting: {
              invoke: {
                src: "wait",
                input: ({ event, state }) => {
                  evaluations.events.push((event as { readonly _tag: unknown })._tag)
                  return state.seconds
                },
                onDone: { target: "Expired" }
              },
              on: {
                Note: { update: { Waiting: ({ state }) => ({ ...state, notes: state.notes + 1 }) } },
                Cancel: { target: "Idle" },
                Restart: { target: "Waiting", reenter: true, data: ({ state }) => state },
                Finish: { target: "Finished" }
              }
            },
            Expired: {
              on: { Wait: { target: "Waiting", data: ({ event }) => ({ seconds: event.seconds, notes: 0 }) } }
            }
          }
        })
      const waiting = (dueAt: number): ClusterMachine.Checkpoint.Progress => ({ _tag: "Waiting", dueAt })
      const settled: ClusterMachine.Checkpoint.Progress = { _tag: "Settled" }
      const status = (invocations: ClusterMachine.Checkpoint.Invocations): ClusterMachine.Checkpoint.Status => ({
        _tag: "Active",
        invocations
      })
      /** The status of a machine whose one timer waits. */
      const waits = (dueAt: number) => status({ Waiting: { wait: waiting(dueAt) } })
      const now = Clock.currentTimeMillis
      const advance = (duration: Duration.Input) => Effect.andThen(TestClock.adjust(duration), settle)
      /** Advances to one millisecond before an instant, checks, and advances to it. */
      const reach = Effect.fnUntraced(function*(instant: number, before: () => void) {
        yield* advance(instant - 1 - (yield* now))
        before()
        yield* advance(1)
      })

      it.effect("fires at its stored due time, without a request", () =>
        Effect.gen(function*() {
          yield* run(makeTimer(), {}, ({ driver, key, send, storage, stored }) =>
            Effect.gen(function*() {
              const dueAt = (yield* now) + 10_000
              assertAccepted(yield* send(wait(10)))
              assert.deepStrictEqual(stored()?.status, waits(dueAt))
              assert.strictEqual(pathOf(stored()), "Waiting")
              assert.strictEqual(keptAlive(driver), 1)
              yield* reach(dueAt, () => {
                assert.strictEqual(pathOf(stored()), "Waiting")
                assert.strictEqual(storage.commitAttempts, 1)
              })
              assert.strictEqual(pathOf(stored()), "Expired")
              assert.deepStrictEqual(storage.entries.get(key)?.origin, {
                _tag: "Invocation",
                path: "Waiting",
                id: "wait"
              })
              assert.strictEqual(stored()?.revision, 2)
              assert.deepStrictEqual(stored()?.status, active)
              assert.strictEqual(keptAlive(driver), 0)
              // The wake-up loaded, and nothing else had to.
              assert.strictEqual(storage.loads, 1)
              assert.strictEqual(storage.commits, 2)
              assert.isTrue(storage.transactionFlags.every(Boolean))
              yield* advance("2 minutes")
              assert.strictEqual(storage.commitAttempts, 2)
            }))
        }))

      it.effect("takes its duration from the state its step entered, through its input", () =>
        Effect.gen(function*() {
          const evaluations = makeEvaluations()
          yield* run(makeTimer(evaluations), {}, ({ send, storage, stored }) =>
            Effect.gen(function*() {
              for (const seconds of [3, 90]) {
                const dueAt = (yield* now) + seconds * 1000
                assertAccepted(yield* send(wait(seconds)))
                assert.deepStrictEqual(stored()?.status, waits(dueAt))
                // Steps that keep the state keep its due time, and evaluate nothing.
                yield* advance("1 second")
                assertAccepted(yield* send({ _tag: "Note" }))
                assert.deepStrictEqual(stored()?.status, waits(dueAt))
                yield* reach(dueAt, () => assert.strictEqual(pathOf(stored()), "Waiting"))
                assert.strictEqual(pathOf(stored()), "Expired")
              }
              assert.deepStrictEqual(evaluations, { events: ["Wait", "Wait"], seconds: [3, 90] })
              assert.strictEqual(storage.commits, 6)
            }))
        }))

      it.effect("is cancelled when its state exits", () =>
        Effect.gen(function*() {
          yield* run(makeTimer(), {}, ({ driver, send, storage, stored }) =>
            Effect.gen(function*() {
              assertAccepted(yield* send(wait(10)))
              yield* advance("9 seconds")
              assertAccepted(yield* send({ _tag: "Cancel" }))
              assert.deepStrictEqual(stored()?.status, active)
              assert.strictEqual(keptAlive(driver), 0)
              yield* advance("2 minutes")
              assert.strictEqual(pathOf(stored()), "Idle")
              assert.strictEqual(storage.commitAttempts, 2)
            }))
        }))

      it.effect("waits for a new due time when its state is entered again", () =>
        Effect.gen(function*() {
          const evaluations = makeEvaluations()
          yield* run(makeTimer(evaluations), {}, ({ send, storage, stored }) =>
            Effect.gen(function*() {
              const first = (yield* now) + 10_000
              assertAccepted(yield* send(wait(10)))
              yield* advance("6 seconds")
              assertAccepted(yield* send({ _tag: "Restart" }))
              const second = first + 6000
              assert.deepStrictEqual(stored()?.status, waits(second))
              assert.deepStrictEqual(evaluations.events, ["Wait", "Restart"])
              yield* reach(second, () => {
                assert.strictEqual(pathOf(stored()), "Waiting")
                assert.strictEqual(storage.commitAttempts, 2)
              })
              assert.strictEqual(pathOf(stored()), "Expired")
              assert.strictEqual(storage.commits, 3)
            }))
        }))

      for (const end of ["Restart", "Cancel"]) {
        it.effect(`ignores a completion that races with the exit of its state (${end})`, () =>
          Effect.gen(function*() {
            const gate = yield* Latch.make()
            yield* run(makeTimer(), {}, ({ send, storage, stored }) =>
              Effect.gen(function*() {
                assertAccepted(yield* send(wait(10)))
                storage.holdCommits(gate.await)
                const exiting = yield* Effect.forkChild(send({ _tag: end }), { startImmediately: true })
                yield* settle
                const exitedAt = yield* now
                // Completes while the step that exits its state is being stored.
                yield* advance("10 seconds")
                storage.holdCommits(Effect.void)
                yield* gate.open
                assertAccepted(yield* Fiber.join(exiting))
                // The second activation is due now as well, and is the one that fires.
                yield* settle
                assert.deepStrictEqual(
                  storage.history.map((checkpoint) => [pathOf(checkpoint), checkpoint.status]),
                  end === "Cancel"
                    ? [["Waiting", waits(exitedAt + 10_000)], ["Idle", active]]
                    : [
                      ["Waiting", waits(exitedAt + 10_000)],
                      ["Waiting", waits(exitedAt + 10_000)],
                      ["Expired", active]
                    ]
                )
                assert.strictEqual(stored()?.revision, storage.commits)
                yield* advance("1 minute")
                assert.strictEqual(storage.commitAttempts, storage.commits)
              }))
          }))
      }

      it.effect("ignores the first activation when the second is due later", () =>
        Effect.gen(function*() {
          const gate = yield* Latch.make()
          let seconds = 10
          const machine = Machine.make({
            id: "Timer",
            root: timerRoot,
            events: TimerEvents,
            timers: { wait: (_: undefined) => Duration.seconds(seconds) }
          }).handle({
            initial: { target: "Idle" },
            states: {
              Idle: { on: { Wait: { target: "Waiting", data: { seconds: 0, notes: 0 } } } },
              Waiting: {
                invoke: { src: "wait", input: () => undefined, onDone: { target: "Expired" } },
                on: { Restart: { target: "Waiting", reenter: true, data: ({ state }) => state } }
              },
              Expired: {}
            }
          })
          yield* run(machine, {}, ({ send, storage, stored }) =>
            Effect.gen(function*() {
              assertAccepted(yield* send(wait(10)))
              seconds = 60
              storage.holdCommits(gate.await)
              const restarting = yield* Effect.forkChild(send({ _tag: "Restart" }), { startImmediately: true })
              yield* settle
              const second = (yield* now) + 60_000
              yield* advance("10 seconds")
              storage.holdCommits(Effect.void)
              yield* gate.open
              assertAccepted(yield* Fiber.join(restarting))
              yield* settle
              assert.deepStrictEqual(stored()?.status, waits(second))
              yield* reach(second, () => {
                assert.strictEqual(pathOf(stored()), "Waiting")
                assert.strictEqual(storage.commitAttempts, 2)
              })
              assert.strictEqual(pathOf(stored()), "Expired")
            }))
        }))

      it.effect("fires again and again in a state that its completion enters again", () =>
        Effect.gen(function*() {
          const machine = Machine.make({
            id: "Periodic",
            root: timerRoot,
            events: TimerEvents,
            timers: { wait: "5 seconds" }
          }).handle({
            initial: { target: "Idle" },
            states: {
              Idle: { on: { Wait: { target: "Waiting", data: { seconds: 0, notes: 0 } } } },
              Waiting: {
                invoke: {
                  src: "wait",
                  onDone: {
                    target: "Waiting",
                    reenter: true,
                    data: ({ state }) => ({ ...state, notes: state.notes + 1 })
                  }
                }
              }
            }
          })
          yield* run(machine, {}, ({ driver, send, storage, stored }) =>
            Effect.gen(function*() {
              const start = yield* now
              assertAccepted(yield* send(wait(0)))
              for (let round = 1; round <= 3; round++) {
                yield* advance("5 seconds")
                assert.deepStrictEqual(leafOf(stored())?.value, { _tag: "Waiting", seconds: 0, notes: round })
                assert.deepStrictEqual(stored()?.status, waits(start + (round + 1) * 5000))
                assert.strictEqual(keptAlive(driver), 1)
              }
              // Several periods at once are applied one after another.
              yield* TestClock.adjust("10 seconds")
              yield* settle
              assert.strictEqual(storage.commits, 6)
              assert.deepStrictEqual(stored()?.status, waits(start + 30_000))
            }))
        }))

      it.effect("fires at once without a duration, in a turn after the one that entered its state", () =>
        Effect.gen(function*() {
          for (const seconds of [0, -5]) {
            yield* run(makeTimer(), {}, ({ send, storage, stored }) =>
              Effect.gen(function*() {
                const entered = yield* now
                assertAccepted(yield* send(wait(seconds)))
                yield* until(() => pathOf(stored()) === "Expired")
                assert.strictEqual(yield* now, entered)
                assert.deepStrictEqual(storage.history.map((checkpoint) => [pathOf(checkpoint), checkpoint.status]), [
                  ["Waiting", waits(entered)],
                  ["Expired", active]
                ])
              }))
          }
        }))

      it.effect("stores a due time that is a date for every duration", () =>
        Effect.gen(function*() {
          for (
            const [seconds, dueAt] of [
              [0.0001, (now: number) => now + 1],
              [1.5, (now: number) => now + 1500],
              [1e300, () => 8.64e15],
              [Infinity, () => 8.64e15]
            ] as const
          ) {
            const machine = Machine.make({
              id: "Timer",
              root: timerRoot,
              events: TimerEvents,
              timers: { wait: (_: undefined) => Duration.seconds(seconds) }
            }).handle({
              initial: { target: "Idle" },
              states: {
                Idle: { on: { Wait: { target: "Waiting", data: { seconds: 0, notes: 0 } } } },
                Waiting: { invoke: { src: "wait", input: () => undefined, onDone: { target: "Expired" } } }
              }
            })
            yield* run(machine, {}, ({ driver, send, stored }) =>
              Effect.gen(function*() {
                const due = dueAt(yield* now)
                assertAccepted(yield* send(wait(0)))
                assert.deepStrictEqual(stored()?.status, waits(due))
                assert.deepStrictEqual(JSON.parse(JSON.stringify(stored()?.status)), stored()?.status)
                assert.strictEqual(new Date(due).getTime(), due)
                yield* advance("10 seconds")
                assert.strictEqual(pathOf(stored()), due === 8.64e15 ? "Waiting" : "Expired")
                // A timer that never ends keeps nothing alive, and no message wakes it.
                assert.strictEqual(keptAlive(driver), 0)
                assert.strictEqual(wakes(driver).length, 0)
              }))
          }
        }))

      describe("next to other work", () => {
        const makeTimeout = (work: Work) =>
          Machine.make({
            id: "Timeout",
            root: loaderRoot,
            events: Events,
            effects: { load: (id: string) => work.run(id) },
            timers: { loadTimeout: "10 seconds" }
          }).handle({
            initial: { target: "Idle" },
            states: {
              Idle: { on: { Load: { target: "Loading", data: ({ event }) => ({ id: event.id, notes: 0 }) } } },
              Loading: {
                invoke: [
                  {
                    src: "load",
                    input: ({ state }) => state.id,
                    onDone: { target: "Loaded", data: ({ output }) => ({ result: output }) },
                    onFailure: { target: "Failed", data: ({ error }) => ({ reason: error.reason }) }
                  },
                  { src: "loadTimeout", onDone: { target: "Idle" } }
                ]
              },
              Loaded: {},
              Failed: {}
            }
          })
        it.effect("stops the effect when it ends first", () =>
          Effect.gen(function*() {
            const work = makeWork()
            yield* run(makeTimeout(work), {}, ({ driver, send, storage, stored }) =>
              Effect.gen(function*() {
                const dueAt = (yield* now) + 10_000
                assertAccepted(yield* send(Event.Load({ id: "a" })))
                assert.deepStrictEqual(work.runs.map(({ input }) => input), ["a"])
                // The running effect has no entry.
                assert.deepStrictEqual(stored()?.status, status({ Loading: { loadTimeout: waiting(dueAt) } }))
                yield* reach(dueAt, () => assert.isFalse(work.runs[0]!.stopped))
                assert.strictEqual(pathOf(stored()), "Idle")
                assert.isTrue(work.runs[0]!.stopped)
                yield* succeed(work.runs[0], "late")
                yield* settle
                assert.strictEqual(storage.commitAttempts, 2)
                assert.deepStrictEqual(stored()?.status, active)
                assert.strictEqual(keptAlive(driver), 0)
              }))
          }))
        it.effect("is cancelled when the effect ends first", () =>
          Effect.gen(function*() {
            const work = makeWork()
            yield* run(makeTimeout(work), {}, ({ driver, send, storage, stored }) =>
              Effect.gen(function*() {
                assertAccepted(yield* send(Event.Load({ id: "a" })))
                yield* advance("9 seconds")
                yield* succeed(work.runs[0], "document a")
                yield* until(() => pathOf(stored()) === "Loaded")
                assert.deepStrictEqual(stored()?.status, active)
                yield* advance("1 minute")
                assert.strictEqual(pathOf(stored()), "Loaded")
                assert.strictEqual(storage.commitAttempts, 2)
                assert.strictEqual(keptAlive(driver), 0)
              }))
          }))
        it.effect("keeps waiting when the effect ends and its state stays", () =>
          Effect.gen(function*() {
            const work = makeWork()
            const machine = Machine.make({
              id: "Side",
              root: loaderRoot,
              events: Events,
              effects: { side: work.run("side") },
              timers: { wait: "10 seconds" }
            }).handle({
              initial: { target: "Idle" },
              states: {
                Idle: { on: { Load: { target: "Loading", data: ({ event }) => ({ id: event.id, notes: 0 }) } } },
                Loading: {
                  invoke: [
                    { src: "side", onDone: { stay: true }, onFailure: { stay: true } },
                    { src: "wait", onDone: { target: "Idle" } }
                  ]
                }
              }
            })
            yield* run(machine, {}, ({ driver, send, stored }) =>
              Effect.gen(function*() {
                const dueAt = (yield* now) + 10_000
                assertAccepted(yield* send(Event.Load({ id: "a" })))
                yield* advance("4 seconds")
                yield* succeed(work.runs[0], "done")
                yield* until(() => stored()?.revision === 2)
                yield* settle
                assert.deepStrictEqual(stored()?.status, status({ Loading: { side: settled, wait: waiting(dueAt) } }))
                assert.strictEqual(keptAlive(driver), 1)
                yield* reach(dueAt, () => assert.strictEqual(pathOf(stored()), "Loading"))
                assert.strictEqual(pathOf(stored()), "Idle")
                assert.deepStrictEqual(stored()?.status, active)
              }))
          }))

        /** Two regions whose timers are due at the given times. */
        const makeRegions = (left: Duration.Input, right: Duration.Input) =>
          Machine.make({
            id: "Regions",
            root: Machine.state({
              states: {
                Idle: {},
                Active: {
                  type: "parallel",
                  states: {
                    left: { states: { Busy: {}, Done: {} } },
                    right: { states: { Busy: {}, Done: {} } }
                  }
                }
              }
            }),
            events: Machine.events({ Go: {}, Stop: {} }),
            timers: { left, right }
          }).handle({
            initial: { target: "Idle" },
            states: {
              Idle: { on: { Go: { target: "Active" } } },
              Active: {
                on: { Stop: { target: "Idle" } },
                states: {
                  left: {
                    initial: { target: "Active.left.Busy" },
                    states: { Busy: { invoke: { src: "left", onDone: { target: "Active.left.Done" } } }, Done: {} }
                  },
                  right: {
                    initial: { target: "Active.right.Busy" },
                    states: { Busy: { invoke: { src: "right", onDone: { target: "Active.right.Done" } } }, Done: {} }
                  }
                }
              }
            }
          })
        const ids = (storage: TestStorage) =>
          storage.history.flatMap(({ origin }) => origin._tag === "Invocation" ? [origin.id] : [])

        it.effect("fires each region at its own time", () =>
          Effect.gen(function*() {
            yield* run(makeRegions("9 seconds", "4 seconds"), {}, ({ driver, send, storage, stored }) =>
              Effect.gen(function*() {
                const start = yield* now
                assertAccepted(yield* send({ _tag: "Go" }))
                assert.deepStrictEqual(
                  stored()?.status,
                  status({
                    "Active.left.Busy": { left: waiting(start + 9000) },
                    "Active.right.Busy": { right: waiting(start + 4000) }
                  })
                )
                yield* reach(start + 4000, () =>
                  assert.strictEqual(storage.commits, 1))
                assert.deepStrictEqual(ids(storage), ["right"])
                assert.deepStrictEqual(
                  stored()?.status,
                  status({ "Active.left.Busy": { left: waiting(start + 9000) } })
                )
                assert.strictEqual(keptAlive(driver), 1)
                yield* reach(start + 9000, () =>
                  assert.strictEqual(storage.commits, 2))
                assert.deepStrictEqual(ids(storage), ["right", "left"])
                assert.deepStrictEqual(stored()?.status, active)
                assert.strictEqual(keptAlive(driver), 0)
              }))
          }))

        it.effect("fires what became due while the entity was down in the order of the resolver", () =>
          Effect.gen(function*() {
            const storage = makeTestStorage()
            const messages = yield* makeMessages
            const machine = makeRegions("9 seconds", "4 seconds")
            const first = yield* startRunner(machine, storage, messages)
            assertAccepted(yield* first.send({ _tag: "Go" }))
            yield* first.stop
            yield* advance("1 minute")
            const restartedAt = yield* now
            yield* startRunner(machine, storage, messages)
            yield* until(() => storage.commits === 3)
            assert.deepStrictEqual(ids(storage), ["left", "right"])
            // The runner took its own start-up time, and no timer took any.
            assert.strictEqual(yield* now, restartedAt + 1001)
          }))
      })

      describe("recovery", () => {
        const sendsOf = (messages: Effect.Success<typeof makeMessages>) =>
          messages.driver.journal.filter((envelope) => envelope._tag === "Request" && envelope.tag === "send").length

        it.effect("waits only for the time that remains, on another runner and without a request", () =>
          Effect.gen(function*() {
            const evaluations = makeEvaluations()
            const storage = makeTestStorage()
            const messages = yield* makeMessages
            const machine = makeTimer(evaluations)
            const first = yield* startRunner(machine, storage, messages)
            const dueAt = (yield* now) + 60_000
            assertAccepted(yield* first.send(wait(60)))
            assertAccepted(yield* first.send({ _tag: "Note" }))
            const before = first.stored()
            assert.deepStrictEqual(before?.status, waits(dueAt))
            yield* advance("10 seconds")
            yield* first.stop
            assert.strictEqual(first.stored(), before)
            assert.strictEqual(keptAlive(messages.driver), 1)
            // Nothing runs, and time passes.
            yield* advance("20 seconds")
            assert.strictEqual(storage.commitAttempts, 2)

            const second = yield* startRunner(machine, storage, messages)
            yield* settle
            assert.strictEqual(second.stored(), before)
            assert.strictEqual(keptAlive(messages.driver), 1)
            yield* reach(dueAt, () => assert.strictEqual(second.stored(), before))
            assert.strictEqual(pathOf(second.stored()), "Expired")
            assert.deepStrictEqual(second.stored()?.status, active)
            assert.strictEqual(storage.commitAttempts, 3)
            assert.strictEqual(keptAlive(messages.driver), 0)
            // The duration was evaluated once, for the step that entered the state.
            assert.deepStrictEqual(evaluations, { events: ["Wait"], seconds: [60] })
            assert.strictEqual(sendsOf(messages), 2)
          }))

        it.effect("fires at once when the due time passed while the entity was down", () =>
          Effect.gen(function*() {
            const evaluations = makeEvaluations()
            const storage = makeTestStorage()
            const messages = yield* makeMessages
            const machine = makeTimer(evaluations)
            const first = yield* startRunner(machine, storage, messages)
            assertAccepted(yield* first.send(wait(60)))
            yield* first.stop
            yield* advance("2 minutes")
            assert.strictEqual(pathOf(first.stored()), "Waiting")
            const restartedAt = yield* now
            const second = yield* startRunner(machine, storage, messages)
            yield* until(() => pathOf(second.stored()) === "Expired")
            assert.strictEqual(yield* now, restartedAt + 1001)
            assert.strictEqual(storage.commitAttempts, 2)
            assert.deepStrictEqual(evaluations.seconds, [60])
            assert.strictEqual(sendsOf(messages), 1)
          }))

        it.effect("keeps its due time when a passivated entity receives a request", () =>
          Effect.gen(function*() {
            const evaluations = makeEvaluations()
            const storage = makeTestStorage()
            const messages = yield* makeMessages
            const runner = yield* startRunner(makeTimer(evaluations), storage, messages, {
              idle: 0,
              // Without keep-alive, an idle entity with a timer can be passivated.
              overrides: {
                saveRequest: (message) =>
                  (message.envelope as { readonly tag?: string }).tag === "Cluster/Entity/keepAlive"
                    ? Effect.succeed(MessageStorage.SaveResult.Success())
                    : messages.storage.saveRequest(message)
              }
            })
            const dueAt = (yield* now) + 120_000
            assertAccepted(yield* runner.send(wait(120)))
            const before = runner.stored()
            yield* advance("30 seconds")
            assert.strictEqual(yield* runner.sharding.activeEntityCount, 0)
            assert.strictEqual(runner.stored(), before)
            assert.strictEqual(storage.commitAttempts, 1)
            assertAccepted(yield* runner.send({ _tag: "Note" }))
            assert.deepStrictEqual(runner.stored()?.status, waits(dueAt))
            assert.deepStrictEqual(evaluations, { events: ["Wait"], seconds: [120] })
          }))

        it.effect("keeps waiting when a reload finds the state it was started from", () =>
          Effect.gen(function*() {
            const evaluations = makeEvaluations()
            yield* run(makeTimer(evaluations), {}, ({ driver, send, storage, stored }) =>
              Effect.gen(function*() {
                const dueAt = (yield* now) + 10_000
                assertAccepted(yield* send(wait(10)))
                storage.failNextCommit()
                const loads = storage.loads
                assertRejected(yield* send({ _tag: "Cancel" }), "PersistenceFailure")
                yield* until(() => storage.loads === loads + 2)
                yield* settle
                assert.strictEqual(keptAlive(driver), 1)
                yield* reach(dueAt, () => assert.strictEqual(pathOf(stored()), "Waiting"))
                assert.strictEqual(pathOf(stored()), "Expired")
                assert.strictEqual(storage.loads, loads + 2)
                assert.deepStrictEqual(evaluations.seconds, [10])
              }))
          }))

        it.effect("starts no timer for a state that was only planned", () =>
          Effect.gen(function*() {
            yield* run(makeTimer(), {}, ({ driver, send, storage, stored }) =>
              Effect.gen(function*() {
                storage.failNextCommit()
                assertRejected(yield* send(wait(10)), "PersistenceFailure")
                yield* settle
                assert.strictEqual(keptAlive(driver), 0)
                yield* advance("1 minute")
                assert.strictEqual(stored(), undefined)
                assert.strictEqual(storage.commitAttempts, 1)
              }))
          }))

        it.effect("starts the timer of a step whose acknowledgement was lost", () =>
          Effect.gen(function*() {
            const evaluations = makeEvaluations()
            const storage = makeTestStorage()
            let failNext = true
            const withTransaction: MessageStorage.MessageStorage["Service"]["withTransaction"] = (effect) =>
              Effect.tap(Effect.provideService(effect, MessageStorage.MemoryTransaction, true), () =>
                Effect.sync(() => {
                  if (!failNext || storage.commits === 0) return
                  failNext = false
                  throw new Error("acknowledgement lost")
                }))
            yield* run(makeTimer(evaluations), { storage, withTransaction }, ({ send, stored }) =>
              Effect.gen(function*() {
                const dueAt = (yield* now) + 10_000
                assertAccepted(yield* send(wait(10)))
                yield* settle
                assert.deepStrictEqual(stored()?.status, waits(dueAt))
                yield* reach(dueAt, () =>
                  assert.strictEqual(pathOf(stored()), "Waiting"))
                assert.strictEqual(pathOf(stored()), "Expired")
                assert.deepStrictEqual(evaluations.seconds, [10])
              }))
          }))
      })

      describe("that stay in their state", () => {
        const makeStaying = (evaluations: Evaluations) =>
          Machine.make({
            id: "Staying",
            root: timerRoot,
            events: TimerEvents,
            timers: {
              wait: (seconds: number) => {
                evaluations.seconds.push(seconds)
                return Duration.seconds(seconds)
              }
            }
          }).handle({
            initial: { target: "Idle" },
            states: {
              Idle: {
                on: { Wait: { target: "Waiting", data: ({ event }) => ({ seconds: event.seconds, notes: 0 }) } }
              },
              Waiting: {
                invoke: { src: "wait", input: ({ state }) => state.seconds, onDone: { stay: true } },
                on: {
                  Note: { update: { Waiting: ({ state }) => ({ ...state, notes: state.notes + 1 }) } },
                  Cancel: { target: "Idle" }
                }
              }
            }
          })
        it.effect("are settled, and fire again only once their state is entered again", () =>
          Effect.gen(function*() {
            const evaluations = makeEvaluations()
            const storage = makeTestStorage()
            const messages = yield* makeMessages
            const machine = makeStaying(evaluations)
            const first = yield* startRunner(machine, storage, messages)
            assertAccepted(yield* first.send(wait(10)))
            yield* advance("10 seconds")
            const settledStatus = status({ Waiting: { wait: settled } })
            assert.deepStrictEqual(first.stored()?.status, settledStatus)
            assert.strictEqual(keptAlive(messages.driver), 0)
            yield* first.stop

            const second = yield* startRunner(machine, storage, messages)
            assertAccepted(yield* second.send({ _tag: "Note" }))
            yield* advance("1 minute")
            assert.deepStrictEqual(second.stored()?.status, settledStatus)
            assert.strictEqual(storage.commitAttempts, 3)
            assert.strictEqual(keptAlive(messages.driver), 0)
            assertAccepted(yield* second.send({ _tag: "Cancel" }))
            assert.deepStrictEqual(second.stored()?.status, active)
            const dueAt = (yield* now) + 20_000
            assertAccepted(yield* second.send(wait(20)))
            assert.deepStrictEqual(second.stored()?.status, waits(dueAt))
            yield* reach(dueAt, () => assert.strictEqual(storage.commitAttempts, 5))
            assert.deepStrictEqual(second.stored()?.status, settledStatus)
            assert.deepStrictEqual(evaluations.seconds, [10, 20])
          }))
      })

      describe("keep-alive", () => {
        it.effect(
          "is held as one request while a timer waits, and released when it fires",
          () =>
            Effect.gen(function*() {
              const storage = makeTestStorage()
              const messages = yield* makeMessages
              const delivered = recordKeepAlive(messages)
              // Within the in-memory threshold, the timer keeps the entity.
              const runner = yield* startRunner(makeTimer(), storage, messages, {
                idle: 0,
                overrides: delivered.overrides,
                inMemoryThreshold: "1 day"
              })
              assertAccepted(yield* runner.send(wait(36 * 60)))
              for (let minutes = 0; minutes < 35; minutes++) {
                yield* advance("1 minute")
                assertHeld(messages.driver)
                assert.strictEqual(yield* runner.sharding.activeEntityCount, 1)
                assert.strictEqual(storage.commits, 1)
              }
              // Once, and again after each claim expired.
              assert.strictEqual(delivered.count(), 4)
              yield* advance("1 minute")
              assert.strictEqual(pathOf(runner.stored()), "Expired")
              assert.strictEqual(keptAlive(messages.driver), 0)
              yield* advance("30 seconds")
              assert.strictEqual(yield* runner.sharding.activeEntityCount, 0)
            }),
          30000
        )

        it.effect(
          "revives an entity whose timer has waited for longer than a claim lasts",
          () =>
            Effect.gen(function*() {
              const storage = makeTestStorage()
              const messages = yield* makeMessages
              const machine = makeTimer()
              const first = yield* startRunner(machine, storage, messages, { idle: 0, inMemoryThreshold: "1 day" })
              const dueAt = (yield* now) + 30 * 60_000
              assertAccepted(yield* first.send(wait(30 * 60)))
              for (let minutes = 0; minutes < 25; minutes++) yield* advance("1 minute")
              assertHeld(messages.driver)
              yield* first.stop
              yield* advance("1 minute")
              assertHeld(messages.driver)

              const second = yield* startRunner(machine, storage, messages, { idle: 0, inMemoryThreshold: "1 day" })
              yield* settle
              assert.deepStrictEqual(second.stored()?.status, waits(dueAt))
              yield* reach(dueAt, () => assert.strictEqual(pathOf(second.stored()), "Waiting"))
              assert.strictEqual(pathOf(second.stored()), "Expired")
              assert.strictEqual(keptAlive(messages.driver), 0)
            }),
          30000
        )

        it.effect("is released when a timer is cancelled", () =>
          Effect.gen(function*() {
            yield* run(makeTimer(), { idle: 0, inMemoryThreshold: "1 day" }, ({ driver, send, sharding }) =>
              Effect.gen(function*() {
                assertAccepted(yield* send(wait(3600)))
                yield* advance("12 minutes")
                assert.strictEqual(keptAlive(driver), 1)
                assertAccepted(yield* send({ _tag: "Cancel" }))
                yield* settle
                assert.strictEqual(keptAlive(driver), 0)
                yield* advance("30 seconds")
                assert.strictEqual(yield* sharding.activeEntityCount, 0)
              }))
          }))
      })

      describe("whose duration cannot be evaluated", () => {
        const makeBroken = (work: Work, order: Array<string>, duration: () => Duration.Input) =>
          Machine.make({
            id: "Broken",
            root: loaderRoot,
            events: Events,
            effects: {
              first: Effect.suspend(() => {
                order.push("first")
                return work.run("first")
              }),
              third: Effect.suspend(() => {
                order.push("third")
                return work.run("third")
              })
            },
            timers: {
              before: "10 seconds",
              broken: (_: undefined) => {
                order.push("duration")
                return duration()
              },
              after: "10 seconds"
            }
          }).handle({
            initial: { target: "Idle" },
            states: {
              Idle: { on: { Load: { target: "Loading", data: ({ event }) => ({ id: event.id, notes: 0 }) } } },
              Loading: {
                invoke: [
                  { src: "first", onDone: { stay: true }, onFailure: { stay: true } },
                  { src: "before", onDone: { stay: true } },
                  { src: "broken", input: () => undefined, onDone: { stay: true } },
                  { src: "third", onDone: { stay: true }, onFailure: { stay: true } },
                  { src: "after", onDone: { stay: true } }
                ]
              }
            }
          })
        const durations = {
          "throws": {
            duration: (): Duration.Input => {
              throw new Error("no duration")
            },
            order: ["duration", "first"]
          },
          "names no duration": {
            duration: () => "soon" as Duration.Input,
            order: ["duration", "first"]
          }
        }
        for (const [name, { duration, order }] of Object.entries(durations)) {
          it.effect(`fails the machine after its step is stored when it ${name}`, () =>
            Effect.gen(function*() {
              const work = makeWork()
              const clusterOrder: Array<string> = []
              const failure = yield* run(
                makeBroken(work, clusterOrder, duration),
                {},
                ({ driver, send, storage, stored }) =>
                  Effect.gen(function*() {
                    const dueAt = (yield* now) + 10_000
                    assertAccepted(yield* send(Event.Load({ id: "a" })))
                    yield* until(() => stored()?.status._tag === "Failed")
                    assert.deepStrictEqual(
                      storage.history.map((checkpoint) => [pathOf(checkpoint), checkpoint.origin._tag]),
                      [
                        ["Loading", "Request"],
                        ["Loading", "Invocation"]
                      ]
                    )
                    // The step stores the due times of the other timers.
                    assert.deepStrictEqual(
                      storage.history[0]?.status,
                      status({ Loading: { before: waiting(dueAt), after: waiting(dueAt) } })
                    )
                    assert.deepStrictEqual(stored()?.origin, { _tag: "Invocation", path: "Loading", id: "broken" })
                    const failed = stored()!.status
                    assert(failed._tag === "Failed")
                    assert.deepStrictEqual(clusterOrder, order)
                    yield* settle
                    assert.isTrue(work.runs.every(({ stopped }) => stopped))
                    assert.strictEqual(keptAlive(driver), 0)
                    yield* advance("1 minute")
                    assert.strictEqual(storage.commitAttempts, 2)
                    assertRejected(yield* send(Event.Note()), "MachineFailed")
                    return failed.failure
                  })
              )
              // The local runtime evaluates the duration in start order instead.
              const localOrder: Array<string> = []
              const ref = yield* LocalMachine.start(makeBroken(makeWork(), localOrder, duration))
              yield* ref.send(Events.Load({ id: "a" }))
              assert.isTrue(Exit.hasDies(yield* Effect.exit(ref.join)))
              const local = yield* ref.snapshot
              assert(local.status === "failed")
              assert.strictEqual(local.state.state.path, "Loading")
              assert.strictEqual(failure, `Error: ${(Cause.squash(local.cause) as Error).message}`)
              assert.deepStrictEqual(localOrder, ["first", ...order.filter((step) => step !== "first")])
            }).pipe(Effect.scoped))
        }

        it.effect("evaluates it again when the failure could not be stored", () =>
          Effect.gen(function*() {
            const work = makeWork()
            const order: Array<string> = []
            const machine = makeBroken(work, order, durations.throws.duration)
            yield* run(machine, {}, ({ send, storage, stored }) =>
              Effect.gen(function*() {
                const dueAt = (yield* now) + 10_000
                storage.onCommit(() => {
                  if (storage.commitAttempts === 2 || storage.commitAttempts === 3) storage.failNextCommit()
                })
                assertAccepted(yield* send(Event.Load({ id: "a" })))
                assert.strictEqual(stored()?.status._tag, "Active")
                yield* advance("9 seconds")
                yield* until(() => stored()?.status._tag === "Failed")
                assert.strictEqual(storage.commitAttempts, 4)
                assert.deepStrictEqual(order.filter((step) => step === "duration").length, 3)
                // Nothing but the failure was stored, so no due time moved.
                assert.deepStrictEqual(
                  storage.history.map(({ revision, status }) => [revision, status._tag]),
                  [[1, "Active"], [2, "Failed"]]
                )
                assert.deepStrictEqual(
                  storage.history[0]?.status,
                  status({ Loading: { before: waiting(dueAt), after: waiting(dueAt) } })
                )
              }))
          }))

        it.effect("reports an earlier invocation that cannot start instead", () =>
          Effect.gen(function*() {
            const machine = Machine.make({
              id: "Broken",
              root: loaderRoot,
              events: Events,
              effects: { load: (_: string) => Effect.void },
              timers: { broken: (_: undefined) => durations.throws.duration() }
            }).handle({
              initial: { target: "Idle" },
              states: {
                Idle: { on: { Load: { target: "Loading", data: ({ event }) => ({ id: event.id, notes: 0 }) } } },
                Loading: {
                  invoke: [
                    {
                      src: "load",
                      input: (): string => {
                        throw new Error("no input")
                      },
                      onDone: { stay: true }
                    },
                    { src: "broken", input: () => undefined, onDone: { stay: true } }
                  ]
                }
              }
            })
            yield* run(machine, {}, ({ send, stored }) =>
              Effect.gen(function*() {
                assertAccepted(yield* send(Event.Load({ id: "a" })))
                assert.deepStrictEqual(stored()?.status, { _tag: "Failed", failure: "Error: no input" })
              }))
          }))

        it.effect("evaluates nothing for a request that is refused", () =>
          Effect.gen(function*() {
            let evaluated = 0
            const machine = Machine.make({
              id: "Refused",
              root: timerRoot,
              events: TimerEvents,
              emittedEvents: Machine.emittedEventsFromSchemas(Changed),
              timers: {
                wait: (_: undefined) => {
                  evaluated += 1
                  return "1 second" as const
                }
              }
            }).handle({
              initial: { target: "Idle" },
              states: {
                Idle: {
                  on: {
                    Wait: {
                      branches: [{ target: "Waiting" }],
                      resolve: ({ select }, enqueue) => {
                        enqueue.emit(new Changed({ value: 1 }))
                        return select.target("Waiting", { data: { seconds: 0, notes: 0 } })
                      }
                    }
                  }
                },
                Waiting: { invoke: { src: "wait", input: () => undefined, onDone: { target: "Expired" } } }
              }
            })
            yield* run(machine, {}, ({ send, stored }) =>
              Effect.gen(function*() {
                assertRejected(yield* send(wait(0)), "EmissionFailure")
                assert.strictEqual(evaluated, 0)
                assert.strictEqual(stored(), undefined)
              }))
          }))
      })

      it.effect("is neither created twice nor moved by a redelivered request", () =>
        Effect.gen(function*() {
          const evaluations = makeEvaluations()
          yield* run(makeTimer(evaluations), {}, ({ driver, send, storage, stored }) =>
            Effect.gen(function*() {
              const dueAt = (yield* now) + 60_000
              assertAccepted(yield* send(wait(60)))
              const [first] = yield* sentRequestIds
              yield* advance("5 seconds")
              assert.deepStrictEqual(yield* redeliver(first!), { _tag: "Accepted" })
              yield* settle
              assert.deepStrictEqual(stored()?.status, waits(dueAt))
              assert.strictEqual(storage.commits, 1)
              assert.strictEqual(keptAlive(driver), 1)
              yield* advance(dueAt - 1 - (yield* now))
              assert.strictEqual(pathOf(stored()), "Waiting")
              yield* advance(1)
              assert.strictEqual(pathOf(stored()), "Expired")
              // Planned again from a state that enters the timer, and discarded.
              assert.deepStrictEqual(yield* redeliver(first!), { _tag: "Accepted" })
              yield* advance("2 minutes")
              assert.deepStrictEqual(evaluations.seconds, [60, 60])
              assert.strictEqual(pathOf(stored()), "Expired")
              assert.deepStrictEqual(stored()?.status, active)
              assert.strictEqual(keptAlive(driver), 0)
            }))
        }))

      describe("another writer", () => {
        const advanced = (dueAt: number) => (checkpoint: ClusterMachine.Checkpoint): ClusterMachine.Checkpoint => ({
          ...checkpoint,
          snapshot: {
            ...checkpoint.snapshot,
            active: [{ path: "" }, { path: "Waiting", value: { _tag: "Waiting", seconds: 1, notes: 7 } }]
          },
          status: waits(dueAt)
        })
        it.effect("moves the due time that a request finds", () =>
          Effect.gen(function*() {
            const evaluations = makeEvaluations()
            yield* run(makeTimer(evaluations), {}, ({ key, send, storage, stored }) =>
              Effect.gen(function*() {
                const start = yield* now
                assertAccepted(yield* send(wait(10)))
                storage.write(key, advanced(start + 30_000))
                assertAccepted(yield* send({ _tag: "Note" }))
                assert.deepStrictEqual(leafOf(stored())?.value, { _tag: "Waiting", seconds: 1, notes: 8 })
                assert.deepStrictEqual(stored()?.status, waits(start + 30_000))
                yield* reach(start + 30_000, () => {
                  assert.strictEqual(pathOf(stored()), "Waiting")
                  assert.strictEqual(stored()?.revision, 3)
                })
                assert.strictEqual(pathOf(stored()), "Expired")
                assert.deepStrictEqual(evaluations.seconds, [10])
              }))
          }))
        for (const [name, offset] of [["a later", 30_000], ["an earlier", 5000]] as const) {
          it.effect(`moves ${name} due time under a completion`, () =>
            Effect.gen(function*() {
              const evaluations = makeEvaluations()
              yield* run(makeTimer(evaluations), {}, ({ key, send, storage, stored }) =>
                Effect.gen(function*() {
                  const start = yield* now
                  assertAccepted(yield* send(wait(10)))
                  storage.write(key, advanced(start + offset))
                  yield* advance(start + 10_000 - 1 - (yield* now))
                  // Only the completion finds the state of the other writer.
                  assert.strictEqual(storage.commitAttempts, 1)
                  yield* advance(1)
                  if (offset > 10_000) {
                    assert.strictEqual(pathOf(stored()), "Waiting")
                    assert.strictEqual(stored()?.revision, 2)
                    yield* reach(start + offset, () => assert.strictEqual(pathOf(stored()), "Waiting"))
                  } else {
                    // Due in the past already.
                    yield* until(() => pathOf(stored()) === "Expired")
                  }
                  assert.strictEqual(pathOf(stored()), "Expired")
                  assert.strictEqual(stored()?.revision, 3)
                  yield* advance("1 minute")
                  assert.strictEqual(stored()?.revision, 3)
                  assert.deepStrictEqual(evaluations.seconds, [10])
                }))
            }))
        }
        it.effect("leaves the state, or fails the machine", () =>
          Effect.gen(function*() {
            for (
              const update of [
                (checkpoint: ClusterMachine.Checkpoint): ClusterMachine.Checkpoint => ({
                  ...checkpoint,
                  snapshot: { ...checkpoint.snapshot, active: [{ path: "" }, { path: "Idle" }] },
                  status: active
                }),
                (checkpoint: ClusterMachine.Checkpoint): ClusterMachine.Checkpoint => ({
                  ...checkpoint,
                  status: { _tag: "Failed", failure: "elsewhere" }
                })
              ]
            ) {
              yield* run(makeTimer(), {}, ({ driver, key, send, storage, stored }) =>
                Effect.gen(function*() {
                  assertAccepted(yield* send(wait(10)))
                  storage.write(key, update)
                  const written = stored()
                  yield* advance("2 minutes")
                  assert.strictEqual(stored(), written)
                  assert.strictEqual(keptAlive(driver), 0)
                }))
            }
          }))
      })

      describe("storage failures while a completion is stored", () => {
        it.effect("retry the commit without failing the machine", () =>
          Effect.gen(function*() {
            const evaluations = makeEvaluations()
            yield* run(makeTimer(evaluations), {}, ({ driver, send, storage, stored }) =>
              Effect.gen(function*() {
                const dueAt = (yield* now) + 10_000
                assertAccepted(yield* send(wait(10)))
                let failures = 3
                storage.onCommit(() => {
                  if (failures-- > 0) storage.failNextCommit()
                })
                yield* advance("10 seconds")
                assert.strictEqual(storage.commitAttempts, 2)
                assert.strictEqual(pathOf(stored()), "Waiting")
                assert.deepStrictEqual(stored()?.status, waits(dueAt))
                assert.strictEqual(keptAlive(driver), 1)
                yield* advance("30 seconds")
                assert.strictEqual(pathOf(stored()), "Expired")
                assert.strictEqual(storage.commitAttempts, 5)
                assert.deepStrictEqual(storage.history.map(({ status }) => status._tag), ["Active", "Active"])
                assert.deepStrictEqual(evaluations.seconds, [10])
                assert.strictEqual(keptAlive(driver), 0)
              }))
          }))
        it.effect("retry until the state can be loaded again", () =>
          Effect.gen(function*() {
            yield* run(makeTimer(), {}, ({ send, storage, stored }) =>
              Effect.gen(function*() {
                assertAccepted(yield* send(wait(10)))
                storage.failNextCommit()
                storage.failNextLoad()
                yield* advance("40 seconds")
                assert.strictEqual(pathOf(stored()), "Expired")
                assert.strictEqual(stored()?.revision, 2)
              }))
          }))
        it.effect("do not fire twice when the acknowledgement of the commit is lost", () =>
          Effect.gen(function*() {
            const storage = makeTestStorage()
            let failNext = true
            const withTransaction: MessageStorage.MessageStorage["Service"]["withTransaction"] = (effect) =>
              Effect.tap(Effect.provideService(effect, MessageStorage.MemoryTransaction, true), () =>
                Effect.sync(() => {
                  if (!failNext || storage.commits < 2) return
                  failNext = false
                  throw new Error("acknowledgement lost")
                }))
            yield* run(makeTimer(), { storage, withTransaction }, ({ driver, send, stored }) =>
              Effect.gen(function*() {
                assertAccepted(yield* send(wait(10)))
                yield* advance("2 minutes")
                assert.strictEqual(pathOf(stored()), "Expired")
                assert.strictEqual(storage.commitAttempts, 2)
                assert.strictEqual(keptAlive(driver), 0)
              }))
          }))
      })

      describe("waits the host stops", () => {
        it.effect("end with a final state, including those of states that stay active", () =>
          Effect.gen(function*() {
            const machine = Machine.make({
              id: "FinalRegions",
              root: Machine.state({
                type: "parallel",
                states: {
                  left: { states: { Busy: {}, Done: { type: "final" } } },
                  right: { states: { Busy: {}, Done: { type: "final" } } }
                }
              }),
              events: TimerEvents,
              timers: { region: "10 seconds", settling: "1 second" }
            }).handle({
              states: {
                left: {
                  invoke: [{ src: "region", onDone: { stay: true } }, { src: "settling", onDone: { stay: true } }],
                  initial: { target: "left.Busy" },
                  states: { Busy: { on: { Note: { stay: true }, Finish: { target: "left.Done" } } } }
                },
                right: {
                  invoke: { src: "region", onDone: { stay: true } },
                  initial: { target: "right.Busy" },
                  states: { Busy: { on: { Finish: { target: "right.Done" } } } }
                }
              }
            })
            yield* run(machine, { idle: 0 }, ({ driver, key, send, sharding, storage, stored }) =>
              Effect.gen(function*() {
                const dueAt = (yield* now) + 10_000
                assertAccepted(yield* send({ _tag: "Note" }))
                yield* advance("1 second")
                assert.deepStrictEqual(
                  stored()?.status,
                  status({
                    left: { region: waiting(dueAt), settling: settled },
                    right: { region: waiting(dueAt) }
                  })
                )
                assertAccepted(yield* send({ _tag: "Finish" }))
                assert.deepStrictEqual(
                  stored()?.snapshot.active.map(({ path }) =>
                    path
                  ),
                  ["", "left", "left.Done", "right", "right.Done"]
                )
                assert.deepStrictEqual(stored()?.status, status({ left: { settling: settled } }))
                assert.strictEqual(keptAlive(driver), 0)
                yield* advance("1 minute")
                assert.strictEqual(storage.commitAttempts, 3)
                assert.strictEqual(yield* sharding.activeEntityCount, 0)
                assertAccepted(yield* send({ _tag: "Note" }))
                yield* advance("1 minute")
                assert.strictEqual(storage.commitAttempts, 4)
                assert.strictEqual(keptAlive(driver), 0)
                // Its states are active and declare the timer, but nothing can fire it.
                storage.write(key, (checkpoint) => ({ ...checkpoint, status: status({ right: { region: settled } }) }))
                assertAccepted(yield* send({ _tag: "Note" }))
                storage.write(key, (checkpoint) => ({
                  ...checkpoint,
                  status: status({ right: { region: waiting(dueAt) } })
                }))
                assertRejected(yield* send({ _tag: "Note" }), "InvalidCheckpoint")
              }))
          }))
        it.effect("end with a failed machine", () =>
          Effect.gen(function*() {
            const work = makeWork()
            const machine = Machine.make({
              id: "FailingNextToTimer",
              root: loaderRoot,
              events: Events,
              effects: { load: work.run("load") as Effect.Effect<string> },
              timers: { wait: "10 seconds" }
            }).handle({
              initial: { target: "Idle" },
              states: {
                Idle: { on: { Load: { target: "Loading", data: ({ event }) => ({ id: event.id, notes: 0 }) } } },
                Loading: {
                  invoke: [{ src: "load", onDone: { stay: true } }, { src: "wait", onDone: { target: "Idle" } }]
                }
              }
            })
            yield* run(machine, {}, ({ driver, send, storage, stored }) =>
              Effect.gen(function*() {
                assertAccepted(yield* send(Event.Load({ id: "a" })))
                yield* Deferred.die(work.runs[0]!.result, new Error("broken"))
                yield* until(() => stored()?.status._tag === "Failed")
                // A failed status has no place for a due time.
                assert.deepStrictEqual(stored()?.status, { _tag: "Failed", failure: "Error: broken" })
                yield* advance("1 minute")
                assert.strictEqual(storage.commitAttempts, 2)
                assert.strictEqual(keptAlive(driver), 0)
              }))
          }))
        it.effect("neither fire nor fail when the runner shuts down", () =>
          Effect.gen(function*() {
            const storage = makeTestStorage()
            const messages = yield* makeMessages
            const runner = yield* startRunner(makeTimer(), storage, messages)
            assertAccepted(yield* runner.send(wait(10)))
            const before = runner.stored()
            yield* runner.stop
            yield* advance("1 minute")
            assert.strictEqual(runner.stored(), before)
            assert.strictEqual(storage.commitAttempts, 1)
          }))
        it.effect("neither fire nor fail when the shard moves to another runner", () =>
          Effect.gen(function*() {
            const evaluations = makeEvaluations()
            const storage = makeTestStorage()
            const messages = yield* makeMessages
            const machine = makeTimer(evaluations)
            let lost = false
            const first = yield* startRunner(machine, storage, messages, {
              inMemoryThreshold: "1 day",
              runnerStorage: Layer.effect(
                RunnerStorage.RunnerStorage,
                Effect.map(RunnerStorage.makeMemory, (runners) =>
                  RunnerStorage.RunnerStorage.of({
                    ...runners,
                    acquire: (address, shardIds) => lost ? Effect.succeed([]) : runners.acquire(address, shardIds),
                    refresh: (address, shardIds) => lost ? Effect.succeed([]) : runners.refresh(address, shardIds)
                  }))
              )
            })
            const dueAt = (yield* now) + 120_000
            assertAccepted(yield* first.send(wait(120)))
            const before = first.stored()
            lost = true
            yield* advance("30 seconds")
            assert.strictEqual(yield* first.sharding.activeEntityCount, 0)
            assert.strictEqual(first.stored(), before)
            assert.strictEqual(keptAlive(messages.driver), 1)
            const second = yield* startRunner(machine, storage, messages)
            yield* reach(dueAt, () => {
              assert.strictEqual(second.stored(), before)
              assert.strictEqual(storage.commitAttempts, 1)
            })
            assert.strictEqual(pathOf(second.stored()), "Expired")
            assert.strictEqual(storage.commitAttempts, 2)
            assert.deepStrictEqual(evaluations.seconds, [120])
          }))
      })

      describe("without a stored due time", () => {
        /** The same machine before it declared its timer. */
        const makeUntimed = (work: Work) =>
          Machine.make({
            id: "Grown",
            root: loaderRoot,
            events: Events,
            effects: { load: (id: string) => work.run(id) }
          }).handle({
            initial: { target: "Idle" },
            states: {
              Idle: { on: { Load: { target: "Loading", data: ({ event }) => ({ id: event.id, notes: 0 }) } } },
              Loading: {
                invoke: {
                  src: "load",
                  input: ({ state }) => state.id,
                  onDone: { target: "Loaded", data: ({ output }) => ({ result: output }) },
                  onFailure: { stay: true }
                }
              }
            }
          })
        const makeTimed = (work: Work, events: Array<unknown>, duration: () => Duration.Input = () => "10 seconds") =>
          Machine.make({
            id: "Grown",
            root: loaderRoot,
            events: Events,
            effects: { load: (id: string) => work.run(id) },
            timers: { wait: (_: undefined) => duration() }
          }).handle({
            initial: { target: "Idle" },
            states: {
              Idle: { on: { Load: { target: "Loading", data: ({ event }) => ({ id: event.id, notes: 0 }) } } },
              Loading: {
                invoke: [
                  {
                    src: "load",
                    input: ({ state }) => state.id,
                    onDone: { target: "Loaded", data: ({ output }) => ({ result: output }) },
                    onFailure: { stay: true }
                  },
                  {
                    src: "wait",
                    input: ({ event }) => {
                      events.push((event as { readonly _tag: unknown })._tag)
                      return undefined
                    },
                    onDone: { target: "Idle" }
                  }
                ],
                on: {
                  Note: { update: { Loading: ({ state }) => ({ ...state, notes: state.notes + 1 }) } },
                  Cancel: {
                    target: "Failed",
                    data: () => {
                      throw new Error("cannot leave")
                    }
                  }
                }
              }
            }
          })
        /** A state that was stored before its machine declared the timer. */
        const makeGrown = Effect.gen(function*() {
          const storage = makeTestStorage()
          const messages = yield* makeMessages
          const untimed = yield* startRunner(makeUntimed(makeWork()), storage, messages)
          assertAccepted(yield* untimed.send(Event.Load({ id: "a" })))
          yield* untimed.stop
          assert.deepStrictEqual(untimed.stored()?.status, active)
          return { storage, messages, before: untimed.stored()! }
        })
        const timed = (dueAt: number) => status({ Loading: { wait: waiting(dueAt) } })

        it.effect("stores one before any work of the state starts, and does not move it again", () =>
          Effect.gen(function*() {
            const { before, messages, storage } = yield* makeGrown
            const work = makeWork()
            const events: Array<unknown> = []
            const machine = makeTimed(work, events)
            const clock = yield* Clock.Clock
            const commits: Array<readonly [runs: number, at: number]> = []
            storage.onCommit(() => commits.push([work.runs.length, clock.currentTimeMillisUnsafe()]))
            const second = yield* startRunner(machine, storage, messages)
            yield* until(() => work.runs.length === 1)
            assert.deepStrictEqual(commits.map(([runs]) => runs), [0])
            const dueAt = commits[0]![1] + 10_000
            assert.deepStrictEqual(second.stored(), {
              ...before,
              revision: 2,
              origin: { _tag: "Timers" },
              status: timed(dueAt)
            })
            assert.isTrue(storage.transactionFlags.every(Boolean))
            assert.deepStrictEqual(events, [Machine.InitialEvent._tag])
            yield* advance("4 seconds")
            yield* second.stop

            const third = yield* startRunner(machine, storage, messages)
            yield* until(() => work.runs.length === 2)
            assert.deepStrictEqual(third.stored()?.status, timed(dueAt))
            assert.strictEqual(storage.commits, 2)
            assert.strictEqual(events.length, 1)
            yield* reach(dueAt, () => assert.strictEqual(pathOf(third.stored()), "Loading"))
            assert.strictEqual(pathOf(third.stored()), "Idle")
            assert.strictEqual(keptAlive(messages.driver), 0)
          }))

        it.effect("starts nothing until it is stored, and evaluates it again for each attempt", () =>
          Effect.gen(function*() {
            const { messages, storage } = yield* makeGrown
            const work = makeWork()
            const events: Array<unknown> = []
            storage.failNextCommit()
            const second = yield* startRunner(makeTimed(work, events), storage, messages)
            yield* until(() => storage.commitAttempts === 2)
            yield* settle
            assert.strictEqual(work.runs.length, 0)
            assert.strictEqual(second.stored()?.revision, 1)
            assert.strictEqual(keptAlive(messages.driver), 1)
            yield* advance("1 second")
            yield* until(() => work.runs.length === 1)
            assert.strictEqual(events.length, 2)
            assert.strictEqual(second.stored()?.revision, 2)
            assert.deepStrictEqual(second.stored()?.origin, { _tag: "Timers" })
          }))

        it.effect("does not overwrite what another writer stored in between", () =>
          Effect.gen(function*() {
            const { messages, storage } = yield* makeGrown
            const work = makeWork()
            const key = storageKey("Worker", "worker-1")
            const dueAt = (yield* now) + 50_000
            storage.onCommit(() => {
              storage.onCommit(() => {})
              storage.write(key, (checkpoint) => ({ ...checkpoint, status: timed(dueAt) }))
            })
            const second = yield* startRunner(makeTimed(work, []), storage, messages)
            yield* advance("1 second")
            yield* until(() => work.runs.length === 1)
            assert.deepStrictEqual(second.stored()?.status, timed(dueAt))
            assert.strictEqual(second.stored()?.revision, 2)
            yield* reach(dueAt, () => assert.strictEqual(pathOf(second.stored()), "Loading"))
            assert.strictEqual(pathOf(second.stored()), "Idle")
          }))

        it.effect("is stored by the step of a request that loads the state itself", () =>
          Effect.gen(function*() {
            const { messages, storage } = yield* makeGrown
            const work = makeWork()
            // The wake-up cannot load, and the request arrives before it tries again.
            storage.failNextLoad()
            const second = yield* startRunner(makeTimed(work, []), storage, messages)
            yield* settle
            assert.strictEqual(work.runs.length, 0)
            const dueAt = (yield* now) + 10_000
            assertAccepted(yield* second.send(Event.Note()))
            assert.strictEqual(second.stored()?.revision, 2)
            assert.strictEqual(second.stored()?.origin._tag, "Request")
            assert.deepStrictEqual(second.stored()?.status, timed(dueAt))
            assert.strictEqual(work.runs.length, 1)
            yield* reach(dueAt, () => assert.strictEqual(pathOf(second.stored()), "Loading"))
            assert.strictEqual(pathOf(second.stored()), "Idle")
          }))

        for (const reason of ["PersistenceFailure", "TransitionFailure"] as const) {
          it.effect(`is stored after a request that loads the state itself is refused (${reason})`, () =>
            Effect.gen(function*() {
              const { messages, storage } = yield* makeGrown
              const work = makeWork()
              storage.failNextLoad()
              const second = yield* startRunner(makeTimed(work, []), storage, messages)
              yield* settle
              if (reason === "PersistenceFailure") {
                storage.onCommit(() => {
                  storage.onCommit(() => {})
                  storage.failNextCommit()
                })
              }
              assertRejected(
                yield* second.send(reason === "PersistenceFailure" ? Event.Note() : Event.Cancel()),
                reason
              )
              // A refusal that knows the stored state stores the due time before it answers.
              if (reason === "PersistenceFailure") yield* advance("1 second")
              yield* settle
              assert.strictEqual(work.runs.length, 1)
              assert.strictEqual(second.stored()?.revision, 2)
              assert.deepStrictEqual(second.stored()?.origin, { _tag: "Timers" })
              assert.strictEqual(keptAlive(messages.driver), 1)
            }))
        }

        it.effect("fails the machine when its duration cannot be evaluated", () =>
          Effect.gen(function*() {
            const { before, messages, storage } = yield* makeGrown
            const work = makeWork()
            const second = yield* startRunner(
              makeTimed(work, [], () => {
                throw new Error("no duration")
              }),
              storage,
              messages
            )
            yield* until(() => second.stored()?.status._tag === "Failed")
            assert.deepStrictEqual(second.stored(), {
              ...before,
              revision: 2,
              origin: { _tag: "Invocation", path: "Loading", id: "wait" },
              status: { _tag: "Failed", failure: "Error: no duration" }
            })
            yield* settle
            assert.isTrue(work.runs.every(({ stopped }) => stopped))
            assert.strictEqual(keptAlive(messages.driver), 0)
          }))
      })

      it.effect("rejects a checkpoint that contradicts itself or the machine", () =>
        Effect.gen(function*() {
          const machine = Machine.make({
            id: "Validated",
            root: timerRoot,
            events: TimerEvents,
            effects: { work: Effect.never },
            timers: { wait: "10 seconds" }
          }).handle({
            initial: { target: "Idle" },
            states: {
              Idle: { on: { Wait: { target: "Waiting", data: { seconds: 0, notes: 0 } } } },
              Waiting: {
                invoke: [{ src: "wait", onDone: { target: "Expired" } }, { src: "work" }],
                on: { Note: { stay: true } }
              }
            }
          })
          yield* run(machine, {}, ({ key, send, storage, stored }) =>
            Effect.gen(function*() {
              yield* settle
              const snapshot = (leaf: object) => ({
                version: 2 as const,
                _tag: "MachineSnapshot" as const,
                active: [{ path: "" }, leaf as { readonly path: string }]
              })
              const inWaiting = snapshot({ path: "Waiting", value: { _tag: "Waiting", seconds: 0, notes: 0 } })
              const write = (snapshot: ClusterMachine.Checkpoint["snapshot"], invocations: unknown) =>
                storage.entries.set(key, {
                  definitionId: "Validated",
                  version: "1",
                  revision: 1,
                  origin: request(Snowflake.Snowflake(0)),
                  snapshot,
                  status: { _tag: "Active", invocations: invocations as never }
                })
              const due = (dueAt: unknown) => ({ Waiting: { wait: { _tag: "Waiting", dueAt } } })
              const invalid: ReadonlyArray<readonly [ClusterMachine.Checkpoint["snapshot"], unknown]> = [
                // A timer of a state that is not active.
                [snapshot({ path: "Idle" }), due(5)],
                [snapshot({ path: "Expired" }), due(5)],
                // A timer of a final machine.
                [snapshot({ path: "Finished" }), { Finished: { wait: { _tag: "Waiting", dueAt: 5 } } }],
                // Not a timer, and not an invocation, of this machine.
                [inWaiting, { Waiting: { work: { _tag: "Waiting", dueAt: 5 } } }],
                [inWaiting, { Waiting: { other: { _tag: "Waiting", dueAt: 5 } } }],
                [inWaiting, { "": { wait: { _tag: "Waiting", dueAt: 5 } } }],
                // Not a due time.
                ...[undefined, null, "5", NaN, Infinity, 1.5, 8.64e15 + 1].map((dueAt) =>
                  [inWaiting, due(dueAt)] as const
                ),
                [inWaiting, { Waiting: { wait: { dueAt: 5 } } }],
                [inWaiting, { Waiting: undefined }],
                [inWaiting, null]
              ]
              for (const [snapshot, invocations] of invalid) {
                write(snapshot, invocations)
                const before = stored()
                assertRejected(yield* send({ _tag: "Note" }), "InvalidCheckpoint")
                yield* settle
                assert.strictEqual(stored(), before)
              }
              assert.strictEqual(storage.commitAttempts, 0)
              write(inWaiting, due(8.64e15))
              assertAccepted(yield* send({ _tag: "Note" }))
              assert.deepStrictEqual(stored()?.status, waits(8.64e15))
            }))
        }))

      it.effect("does not mistake names a model chooses for properties of objects", () =>
        Effect.gen(function*() {
          const machine = Machine.make({
            id: "Names",
            root: Machine.state({ states: { constructor: {}, Done: {} } }),
            events: TimerEvents,
            timers: { wait: "10 seconds" }
          }).handle({
            initial: { target: "constructor" },
            states: {
              constructor: {
                invoke: [
                  { src: "wait", id: "toString", onDone: { stay: true } },
                  { src: "wait", id: "__proto__", onDone: { stay: true } }
                ],
                on: { Note: { stay: true } }
              }
            }
          })
          const storage = makeTestStorage()
          const messages = yield* makeMessages
          const first = yield* startRunner(machine, storage, messages)
          const dueAt = (yield* now) + 10_000
          assertAccepted(yield* first.send({ _tag: "Note" }))
          const stored = () => {
            const { status } = first.stored()!
            assert(status._tag === "Active")
            return Object.entries(status.invocations).map(([path, invocations]) => [path, Object.entries(invocations)])
          }
          assert.deepStrictEqual(stored(), [["constructor", [["toString", waiting(dueAt)], [
            "__proto__",
            waiting(dueAt)
          ]]]])
          yield* first.stop
          yield* startRunner(machine, storage, messages)
          yield* reach(dueAt, () => assert.strictEqual(storage.commitAttempts, 1))
          assert.deepStrictEqual(stored(), [["constructor", [["toString", settled], ["__proto__", settled]]]])
        }))

      it.effect("starts no timer of a machine that mixes one with a refused invocation", () =>
        Effect.gen(function*() {
          let evaluated = 0
          const machine = Machine.make({
            id: "Mixed",
            root: timerRoot,
            events: TimerEvents,
            streams: { numbers: Stream.make(1) },
            timers: {
              wait: (_: undefined) => {
                evaluated += 1
                return "1 second" as const
              }
            }
          }).handle({
            initial: { target: "Idle" },
            states: {
              Idle: { on: { Wait: { target: "Waiting", data: { seconds: 0, notes: 0 } } } },
              Waiting: { invoke: { src: "wait", input: () => undefined, onDone: { target: "Expired" } } },
              Expired: { invoke: { src: "numbers", onElement: { stay: true }, onDone: { stay: true } } }
            }
          })
          yield* run(machine, {}, ({ driver, send, storage }) =>
            Effect.gen(function*() {
              assertRejected(yield* send(wait(0)), "UnsupportedProcessLocal")
              yield* advance("1 minute")
              assert.strictEqual(evaluated, 0)
              assert.strictEqual(storage.commitAttempts, 0)
              assert.strictEqual(keptAlive(driver), 0)
            }))
        }))

      it.effect("traces a wait like the local runtime, with the entity as its process", () =>
        Effect.gen(function*() {
          const spans: Array<Tracer.Span> = []
          const tracer = Tracer.make({
            span(options) {
              const span = new Tracer.NativeSpan(options)
              spans.push(span)
              return span
            }
          })
          yield* run(makeTimer(), {}, ({ send, stored }) =>
            Effect.gen(function*() {
              assertAccepted(yield* send(wait(10)))
              yield* advance("10 seconds")
              assert.strictEqual(pathOf(stored()), "Expired")
            })).pipe(Effect.withTracer(tracer))
          const invoked = spans.filter(({ name }) => name === "Machine.invoke")
          assert.deepStrictEqual(invoked.map(({ attributes }) => Object.fromEntries(attributes)), [{
            "machine.id": "Timer",
            "machine.state.path": "Waiting",
            "machine.invoke.id": "wait",
            "machine.invoke.source": "wait",
            "machine.invoke.kind": "Timer",
            "entity.type": "Worker",
            "entity.id": "worker-1"
          }])
        }))

      it.effect("orders the results of the in-memory storage for due times stored on their own", () =>
        Effect.gen(function*() {
          const storage = yield* ClusterMachine.Storage
          const address = {
            entityType: "MemoryTimer",
            entityId: "worker-1",
            shardId: { group: "default", id: 1 }
          } as any
          const { Committed, Duplicate, RevisionConflict } = ClusterMachine.CommitResult
          const checkpoint = (
            revision: number,
            origin: ClusterMachine.Checkpoint.Origin
          ): ClusterMachine.Checkpoint => ({
            definitionId: "Worker",
            version: "1",
            revision,
            origin,
            snapshot: { version: 2, _tag: "MachineSnapshot", active: [{ path: "" }] },
            status: waits(revision)
          })
          const timers: ClusterMachine.Checkpoint.Origin = { _tag: "Timers" }
          const first = request(Snowflake.Snowflake(1))
          assert.deepStrictEqual(yield* storage.commit(address, checkpoint(1, first)), Committed())
          assert.deepStrictEqual(yield* storage.commit(address, checkpoint(1, timers)), RevisionConflict())
          assert.deepStrictEqual(yield* storage.commit(address, checkpoint(2, timers)), Committed())
          assert.deepStrictEqual(yield* storage.commit(address, checkpoint(2, timers)), RevisionConflict())
          assert.deepStrictEqual(yield* storage.commit(address, checkpoint(3, first)), Duplicate())
          assert.deepStrictEqual(yield* storage.load(address), Option.some(checkpoint(2, timers)))
        }).pipe(Effect.provide(ClusterMachine.layerMemory)))
    })

    it.effect("orders the results of the in-memory storage for a checkpoint without a request", () =>
      Effect.gen(function*() {
        const storage = yield* ClusterMachine.Storage
        const address = {
          entityType: "MemoryWorker",
          entityId: "worker-1",
          shardId: { group: "default", id: 1 }
        } as any
        const { Committed, Duplicate, RevisionConflict } = ClusterMachine.CommitResult
        const checkpoint = (
          revision: number,
          origin: ClusterMachine.Checkpoint.Origin
        ): ClusterMachine.Checkpoint => ({
          definitionId: "Worker",
          version: "1",
          revision,
          origin,
          snapshot: { version: 2, _tag: "MachineSnapshot", active: [{ path: "" }] },
          status: active
        })
        const invocation: ClusterMachine.Checkpoint.Origin = { _tag: "Invocation", path: "", id: "load" }
        const first = request(Snowflake.Snowflake(1))
        assert.deepStrictEqual(yield* storage.load(address), Option.none())
        assert.deepStrictEqual(yield* storage.commit(address, checkpoint(1, first)), Committed())
        // The same invocation is compared by its revision alone.
        assert.deepStrictEqual(yield* storage.commit(address, checkpoint(1, invocation)), RevisionConflict())
        assert.deepStrictEqual(yield* storage.commit(address, checkpoint(2, invocation)), Committed())
        assert.deepStrictEqual(yield* storage.commit(address, checkpoint(2, invocation)), RevisionConflict())
        assert.deepStrictEqual(yield* storage.commit(address, checkpoint(3, invocation)), Committed())
        // Requests committed before are still recognized.
        assert.deepStrictEqual(yield* storage.commit(address, checkpoint(4, first)), Duplicate())
        const loaded = yield* storage.loadForRequest(address, Snowflake.Snowflake(1))
        assert.isTrue(loaded.processed)
        assert.deepStrictEqual(loaded.checkpoint, yield* storage.load(address))
        assert.deepStrictEqual(yield* storage.load(address), Option.some(checkpoint(3, invocation)))
      }).pipe(Effect.provide(ClusterMachine.layerMemory)))
  })
})
