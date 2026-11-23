import { assert, describe, it } from "@effect/vitest"
import { type Duration, Effect, Exit, Fiber, Latch, Layer, Option, Schema, SchemaGetter, SchemaIssue } from "effect"
import {
  ClusterError,
  MessageStorage,
  RunnerHealth,
  Runners,
  RunnerStorage,
  Sharding,
  ShardingConfig,
  Snowflake
} from "effect/cluster"
import { TestClock } from "effect/testing"
import { Machine } from "../../../src/index.js"
import { ClusterMachine } from "../../../src/unstable/cluster/index.js"
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
              enqueue.stop(UnsupportedChild)
              return select.target("Count", { data: current, decoded: true })
            }
          }
        }
      },
      Done: {}
    }
  })
}
const storageKey = (entityType: string, entityId: string): string => `${entityType}\u0000${entityId}`
const makeTestStorage = () => {
  const entries = new Map<string, ClusterMachine.Checkpoint>()
  const requests = new Map<string, Set<Snowflake.Snowflake>>()
  const transactionFlags: Array<boolean> = []
  let commits = 0
  let commitAttempts = 0
  let loads = 0
  let failNextCommit = false
  let failNextLoad = false
  let beforeCommit: () => void = () => {}
  const service = ClusterMachine.Storage.of({
    load: (address, requestId) =>
      MessageStorage.MemoryTransaction.use((inTransaction) =>
        Effect.sync(() => {
          loads += 1
          transactionFlags.push(inTransaction)
          if (failNextLoad) {
            failNextLoad = false
            throw new Error("checkpoint unavailable")
          }
          const key = storageKey(address.entityType, address.entityId)
          return {
            checkpoint: Option.fromNullishOr(entries.get(key)),
            processed: requests.get(key)?.has(requestId) ?? false
          }
          // oxlint-disable-next-line typescript/unbound-method -- `refail` is a standalone combinator that does not use `this`.
        }).pipe(ClusterError.PersistenceError.refail)
      ),
    commit: (address, checkpoint) =>
      MessageStorage.MemoryTransaction.use((inTransaction) =>
        Effect.sync(() => {
          transactionFlags.push(inTransaction)
          commitAttempts += 1
          beforeCommit()
          if (failNextCommit) {
            failNextCommit = false
            throw new Error("checkpoint unavailable")
          }
          const key = storageKey(address.entityType, address.entityId)
          let processed = requests.get(key)
          if (processed === undefined) {
            processed = new Set()
            requests.set(key, processed)
          }
          if (processed.has(checkpoint.requestId)) {
            return ClusterMachine.CommitResult.Duplicate()
          }
          if (checkpoint.revision !== (entries.get(key)?.revision ?? 0) + 1) {
            return ClusterMachine.CommitResult.RevisionConflict()
          }
          processed.add(checkpoint.requestId)
          entries.set(key, checkpoint)
          commits += 1
          return ClusterMachine.CommitResult.Committed()
          // oxlint-disable-next-line typescript/unbound-method -- `refail` is a standalone combinator that does not use `this`.
        }).pipe(ClusterError.PersistenceError.refail)
      )
  })
  return {
    service,
    entries,
    requests,
    transactionFlags,
    get commits() {
      return commits
    },
    get commitAttempts() {
      return commitAttempts
    },
    get loads() {
      return loads
    },
    /** Stores a checkpoint the way another instance of the entity would. */
    write(key: string, update: (current: ClusterMachine.Checkpoint) => ClusterMachine.Checkpoint) {
      const current = entries.get(key)!
      entries.set(key, { ...update(current), revision: current.revision + 1 })
    },
    /** Runs before each commit decides its result. */
    onCommit(run: () => void) {
      beforeCommit = run
    },
    snapshot() {
      return {
        entries: new Map(entries),
        requests: new Map(Array.from(requests, ([key, value]) => [key, new Set(value)])),
        commits
      }
    },
    restore(snapshot: {
      readonly entries: Map<string, ClusterMachine.Checkpoint>
      readonly requests: Map<string, Set<Snowflake.Snowflake>>
      readonly commits: number
    }) {
      entries.clear()
      for (const [key, value] of snapshot.entries) {
        entries.set(key, value)
      }
      requests.clear()
      for (const [key, value] of snapshot.requests) {
        requests.set(key, value)
      }
      commits = snapshot.commits
    },
    failNextCommit() {
      failNextCommit = true
    },
    failNextLoad() {
      failNextLoad = true
    }
  }
}
const config = (entityMaxIdleTime: Duration.Input = "10 minutes") =>
  ShardingConfig.layer({
    entityMailboxCapacity: 10,
    entityMaxIdleTime,
    entityTerminationTimeout: 0,
    entityMessagePollInterval: 5000,
    sendRetryInterval: 100,
    refreshAssignmentsInterval: 0
  })
const makeLayer = (
  bridge: ClusterMachine.ClusterMachine<any, any, never>,
  storage: ClusterMachine.Storage["Service"],
  enqueue?: (event: any) => Effect.Effect<void, unknown>,
  entityMaxIdleTime?: Duration.Input,
  overrides?: Partial<MessageStorage.MessageStorage["Service"]>
) => {
  const messageStorageLayer = overrides === undefined ?
    MessageStorage.layerMemory :
    Layer.effect(
      MessageStorage.MessageStorage,
      Effect.map(MessageStorage.MemoryDriver, (driver) =>
        MessageStorage.MessageStorage.of({
          ...driver.storage,
          ...overrides
        }))
    ).pipe(Layer.provideMerge(MessageStorage.MemoryDriver.layer))
  return bridge.toLayer(enqueue === undefined ? undefined : { enqueue }).pipe(
    Layer.provide(Layer.succeed(ClusterMachine.Storage, storage)),
    Layer.provideMerge(Sharding.layer),
    Layer.provide(Runners.layerNoop),
    Layer.provideMerge(messageStorageLayer),
    Layer.provide(RunnerStorage.layerMemory),
    Layer.provide(RunnerHealth.layerNoop),
    Layer.provide(config(entityMaxIdleTime))
  )
}
const countOf = (storage: ReturnType<typeof makeTestStorage>, key: string) => {
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
  storage: ReturnType<typeof makeTestStorage>,
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
        machineId: "Counter",
        version: "1",
        revision: 1,
        requestId: firstId,
        snapshot: {
          version: 2,
          _tag: "MachineSnapshot",
          active: [{ path: "" }, { path: "Count" as const, value: { _tag: "Count", value: "1" } }]
        }
      }
      const second: ClusterMachine.Checkpoint = {
        ...first,
        revision: 2,
        requestId: secondId,
        snapshot: {
          version: 2,
          _tag: "MachineSnapshot",
          active: [{ path: "" }, { path: "Count" as const, value: { _tag: "Count", value: "2" } }]
        }
      }
      assert.deepStrictEqual(yield* storage.commit(address, first), ClusterMachine.CommitResult.Committed())
      assert.deepStrictEqual(yield* storage.commit(address, second), ClusterMachine.CommitResult.Committed())
      assert.deepStrictEqual(yield* storage.commit(address, first), ClusterMachine.CommitResult.Duplicate())
      const loaded = yield* storage.load(address, firstId)
      assert.isTrue(loaded.processed)
      assert.deepStrictEqual(Option.getOrThrow(loaded.checkpoint), second)
    }).pipe(Effect.provide(ClusterMachine.layerMemory)))
  it.effect("rejects incompatible and undecodable checkpoints without resetting", () =>
    Effect.gen(function*() {
      const cases: ReadonlyArray<{
        readonly entityType: string
        readonly machineId: string
        readonly version: string
        readonly snapshot: Machine.Machine.EncodedSnapshot
        readonly reason: ClusterMachine.RejectionReason
      }> = [
        {
          entityType: "WrongMachineCounter",
          machineId: "Other",
          version: "1",
          snapshot: {
            version: 2,
            _tag: "MachineSnapshot",
            active: [{ path: "" }, { path: "Count" as const, value: { _tag: "Count", value: "0" } }]
          },
          reason: "MachineIdMismatch"
        },
        {
          entityType: "WrongVersionCounter",
          machineId: "Counter",
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
          machineId: "Counter",
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
          machineId: testCase.machineId,
          version: testCase.version,
          revision: 1,
          requestId: Snowflake.Snowflake(0),
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
  it.effect("rejects machines with invoke configurations", () =>
    Effect.gen(function*() {
      const states = Machine.state({ states: { Count } })
      const invoked = Machine.make({
        effects: { source1: Effect.suspend(() => Effect.void) },
        id: "Invoked",
        root: states,
        events: Machine.eventsFromSchemas(Increment)
      }).handle({
        initial: {
          target: "Count",
          decoded: true,
          data: new Count({ value: 0 })
        },
        states: {
          Count: {
            invoke: { src: "source1", id: "child", onDone: { stay: true } }
          }
        }
      })
      const bridge = ClusterMachine.make("InvokedCounter", invoked, { version: "1" })
      const storage = makeTestStorage()
      yield* Effect.gen(function*() {
        yield* TestClock.adjust(1)
        const makeClient = yield* bridge.entity.client
        assertRejected(
          yield* makeClient("counter-1").send(new Increment({ by: 1, block: false })),
          "UnsupportedProcessLocal"
        )
        assert.strictEqual(storage.commits, 0)
      }).pipe(Effect.provide(makeLayer(bridge, storage.service)))
    }))

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
          machineId: "Counter",
          version: "1",
          revision: 4,
          requestId: Snowflake.Snowflake(0),
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
            [{ ...valid, machineId: "Other" }, "MachineIdMismatch"],
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
                machineId: "Counter",
                version: "1",
                revision: 1,
                requestId: Snowflake.Snowflake(0),
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
                  enqueue.stop(UnsupportedChild)
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
        machineId: "Counter",
        version: "1",
        revision,
        requestId: Snowflake.Snowflake(requestId),
        snapshot: { version: 2, _tag: "MachineSnapshot", active: [{ path: "" }] }
      })
      const loadedRevision = storage.load(address, Snowflake.Snowflake(99)).pipe(
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
      assert.isFalse((yield* storage.load(address, Snowflake.Snowflake(2))).processed)
      assert.deepStrictEqual(yield* loadedRevision, Option.some(1))
      assert.deepStrictEqual(yield* storage.commit(address, checkpoint(2, 2)), Committed())
      // A committed request id is a duplicate whatever its revision.
      for (const revision of [0, 1, 2, 3, 9]) {
        assert.deepStrictEqual(yield* storage.commit(address, checkpoint(revision, 1)), Duplicate())
      }
      assert.deepStrictEqual(yield* loadedRevision, Option.some(2))
    }).pipe(Effect.provide(ClusterMachine.layerMemory)))
})
