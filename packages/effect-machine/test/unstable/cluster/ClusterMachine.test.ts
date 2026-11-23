import { assert, describe, it } from "@effect/vitest"
import {
  Context,
  Data,
  Deferred,
  type Duration,
  Effect,
  Exit,
  Fiber,
  Latch,
  Layer,
  Option,
  Schema,
  SchemaGetter,
  SchemaIssue,
  Scope,
  Stream,
  Tracer
} from "effect"
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
import { LocalMachine, Machine } from "../../../src/index.js"
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
const request = (requestId: Snowflake.Snowflake): ClusterMachine.Checkpoint.Origin => ({ _tag: "Request", requestId })
const active: ClusterMachine.Checkpoint.Status = { _tag: "Active", settled: [] }
const storageKey = (entityType: string, entityId: string): string => `${entityType}\u0000${entityId}`
const makeTestStorage = () => {
  const entries = new Map<string, ClusterMachine.Checkpoint>()
  const requests = new Map<string, Set<Snowflake.Snowflake>>()
  const transactionFlags: Array<boolean> = []
  const history: Array<ClusterMachine.Checkpoint> = []
  let commits = 0
  let commitAttempts = 0
  let loads = 0
  let failNextCommit = false
  let failNextLoad = false
  let beforeCommit: () => void = () => {}
  let hold: Effect.Effect<void> = Effect.void
  const failingLoad = () => {
    loads += 1
    if (failNextLoad) {
      failNextLoad = false
      throw new Error("checkpoint unavailable")
    }
  }
  const service = ClusterMachine.Storage.of({
    load: (address) =>
      MessageStorage.MemoryTransaction.use((inTransaction) =>
        Effect.sync(() => {
          transactionFlags.push(inTransaction)
          failingLoad()
          return Option.fromNullishOr(entries.get(storageKey(address.entityType, address.entityId)))
          // oxlint-disable-next-line typescript/unbound-method -- `refail` is a standalone combinator that does not use `this`.
        }).pipe(ClusterError.PersistenceError.refail)
      ),
    loadForRequest: (address, requestId) =>
      MessageStorage.MemoryTransaction.use((inTransaction) =>
        Effect.sync(() => {
          transactionFlags.push(inTransaction)
          failingLoad()
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
        Effect.suspend(() => hold).pipe(
          Effect.andThen(Effect.sync(() => {
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
            const { origin } = checkpoint
            if (origin._tag === "Request" && processed.has(origin.requestId)) {
              return ClusterMachine.CommitResult.Duplicate()
            }
            if (checkpoint.revision !== (entries.get(key)?.revision ?? 0) + 1) {
              return ClusterMachine.CommitResult.RevisionConflict()
            }
            if (origin._tag === "Request") processed.add(origin.requestId)
            entries.set(key, checkpoint)
            history.push(checkpoint)
            commits += 1
            return ClusterMachine.CommitResult.Committed()
          })),
          // oxlint-disable-next-line typescript/unbound-method -- `refail` is a standalone combinator that does not use `this`.
          ClusterError.PersistenceError.refail
        )
      )
  })
  return {
    service,
    entries,
    requests,
    transactionFlags,
    /** Every checkpoint that was committed, in order, including rolled back ones. */
    history,
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
    /** Runs before each commit, which waits for it. */
    holdCommits(effect: Effect.Effect<void>) {
      hold = effect
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
/** Adapts a machine whose types do not matter to its test. */
const adapt = (type: string, machine: Machine.Machine.Any): ClusterMachine.ClusterMachine<any, any, never> =>
  (ClusterMachine.make as any)(type, machine, { version: "1" })
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
      Timer: () =>
        Machine.make(base).handle({
          initial,
          states: {
            Count: {},
            Other: {
              invoke: {
                src: "wait",
                onDone: {
                  target: "Count",
                  decoded: true,
                  data: () => new Count({ value: 1 })
                }
              }
            }
          }
        }),
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
        }),
      Child: () => Machine.make(base).handle({ initial, states: { Count: {}, Other: { invoke: { src: "child" } } } })
    }
    for (const kind of ["Timer", "Stream", "Logic", "Child"] as const) {
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
          machineId: "Counter",
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
        readonly storage?: ReturnType<typeof makeTestStorage>
      },
      body: (host: {
        readonly storage: ReturnType<typeof makeTestStorage>
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
        options.withTransaction === undefined ? undefined : { withTransaction: options.withTransaction }
      )))
    }

    /** Keep-alive requests that wait for a reply, which is what revives an entity. */
    const keptAlive = (driver: MessageStorage.MemoryDriver["Service"]) =>
      Array.from(driver.unprocessed).filter((envelope) =>
        envelope._tag === "Request" && envelope.tag === "Cluster/Entity/keepAlive"
      ).length

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
        command: /^UnsupportedProcessLocal: Machine commands require a managed local process$/,
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
                            enqueue.stop(UnsupportedChild)
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
        "self.send": ({ self }) => self.send({ _tag: "Note" }),
        "self.sessionId": ({ self }) => Effect.sync(() => self.sessionId),
        "children.spawn": ({ children }) => children.spawn(UnsupportedChild),
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
          yield* run(makeCapable(() => Machine.stopChild(UnsupportedChild), []), {}, ({ send, stored }) =>
            Effect.gen(function*() {
              assertAccepted(yield* send(Event.Note()))
              yield* until(() =>
                stored()?.status._tag === "Failed"
              )
              const status = stored()!.status
              assert(status._tag === "Failed")
              assert.match(status.failure, /Service not found: effect\/Machine\/MachineRuntime/)
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
            settled: [{ path: "Loading", id: "first" }, { path: "Loading", id: "update" }]
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
                machineId: "Loader",
                version: "1",
                revision: 1,
                origin: request(Snowflake.Snowflake(0)),
                snapshot: { version: 2, _tag: "MachineSnapshot", active: [{ path: "" }, { path: "Idle" }] },
                status: { _tag: "Active", settled: [{ path: "Loading", id: "load" }] }
              })
              assertRejected(yield* send(Event.Note()), "InvalidCheckpoint")
              assert.strictEqual(stored()?.revision, 1)
              for (
                const status of [
                  undefined,
                  { _tag: "Other" },
                  { _tag: "Failed" },
                  { _tag: "Active" },
                  { _tag: "Active", settled: [{ path: "Idle" }] }
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

    const makeMessages = Layer.build(MessageStorage.layerMemory).pipe(
      Effect.provide(config()),
      Effect.map((context) => ({
        storage: Context.get(context, MessageStorage.MessageStorage),
        driver: Context.get(context, MessageStorage.MemoryDriver)
      }))
    )
    /** One runner over storages that outlive it. */
    const startRunner = Effect.fnUntraced(function*(
      machine: Machine.Machine.Any,
      storage: ReturnType<typeof makeTestStorage>,
      messages: Effect.Success<typeof makeMessages>,
      options: {
        readonly idle?: Duration.Input
        readonly overrides?: Partial<MessageStorage.MessageStorage["Service"]>
        readonly runnerStorage?: Layer.Layer<RunnerStorage.RunnerStorage>
      } = {}
    ) {
      const bridge = adapt("Worker", machine)
      // Runners share a machine id here, and ids are unique per millisecond.
      yield* TestClock.adjust("1 second")
      const scope = yield* Scope.fork(yield* Effect.scope)
      const context = yield* bridge.toLayer().pipe(
        Layer.provide(Layer.succeed(ClusterMachine.Storage, storage.service)),
        Layer.provideMerge(Sharding.layer),
        Layer.provide(Runners.layerNoop),
        Layer.provide(
          Layer.succeed(
            MessageStorage.MessageStorage,
            MessageStorage.MessageStorage.of({ ...messages.storage, ...options.overrides })
          )
        ),
        Layer.provide(options.runnerStorage ?? RunnerStorage.layerMemory),
        Layer.provide(RunnerHealth.layerNoop),
        Layer.provide(config(options.idle)),
        Layer.buildWithScope(scope)
      )
      yield* TestClock.adjust(1)
      const client = (yield* Effect.provideContext(bridge.entity.client, context))("worker-1")
      return {
        stored: () => storage.entries.get(storageKey("Worker", "worker-1")),
        send: (event: object): Effect.Effect<ClusterMachine.Accepted | ClusterMachine.Rejected> =>
          Effect.orDie(client.send(event as never) as Effect.Effect<any, unknown>),
        sharding: Context.get(context, Sharding.Sharding),
        stop: Scope.close(scope, Exit.void)
      }
    })

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

      it.effect("still revives an entity whose work has run for longer than a claim lasts", () =>
        Effect.gen(function*() {
          const work = makeWork()
          yield* run(makeLoader(work), { idle: 0 }, ({ driver, send, sharding }) =>
            Effect.gen(function*() {
              assertAccepted(yield* send(Event.Load({ id: "a" })))
              for (let minutes = 0; minutes < 16; minutes++) {
                yield* TestClock.adjust("1 minute")
                yield* settle
                assert.strictEqual(keptAlive(driver), 1)
              }
              assert.strictEqual(yield* sharding.activeEntityCount, 1)
              assert.strictEqual(work.runs.length, 1)
              assert.isFalse(work.runs[0]!.stopped)
              // The requests that were replaced are answered.
              assertAccepted(yield* send(Event.Cancel()))
              yield* settle
              assert.strictEqual(keptAlive(driver), 0)
              const sent = driver.journal.length
              yield* TestClock.adjust("6 minutes")
              yield* settle
              assert.strictEqual(driver.journal.length, sent)
              assert.strictEqual(yield* sharding.activeEntityCount, 0)
            }))
        }))

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

    describe("parity with the local runtime", () => {
      type Action =
        | { readonly _tag: "Send"; readonly event: object }
        | { readonly _tag: "End"; readonly run: number; readonly exit: Exit.Exit<string, { readonly reason: string }> }
      const sends = (event: object): Action => ({ _tag: "Send", event })
      const ends = (index: number, exit: Exit.Exit<string, { readonly reason: string }>): Action => ({
        _tag: "End",
        run: index,
        exit
      })
      const makeUnhandled = (work: Work) =>
        Machine.make({
          id: "Unhandled",
          root: loaderRoot,
          events: Events,
          effects: { load: (id: string) => work.run(id) as Effect.Effect<string> }
        }).handle({
          initial: { target: "Idle" },
          states: {
            Idle: { on: { Load: { target: "Loading", data: ({ event }) => ({ id: event.id, notes: 0 }) } } },
            Loading: {
              invoke: {
                src: "load",
                input: ({ state }) => state.id,
                onDone: { target: "Loaded", data: ({ output }) => ({ result: output }) }
              }
            },
            Loaded: {}
          }
        })
      const makeStays = (work: Work) =>
        Machine.make({
          id: "Stays",
          root: loaderRoot,
          events: Events,
          effects: { first: work.run("first"), second: work.run("second") }
        }).handle({
          initial: { target: "Idle" },
          states: {
            Idle: { on: { Load: { target: "Loading", data: ({ event }) => ({ id: event.id, notes: 0 }) } } },
            Loading: {
              invoke: [
                {
                  src: "first",
                  onDone: { update: { Loading: ({ state }) => ({ ...state, notes: state.notes + 1 }) } },
                  onFailure: { stay: true }
                },
                {
                  src: "second",
                  onDone: { target: "Loaded", data: ({ output }) => ({ result: output }) },
                  onFailure: { stay: true }
                }
              ],
              on: { Cancel: { target: "Idle" } }
            },
            Loaded: {},
            Failed: {}
          }
        })
      const scenarios: Record<
        string,
        { readonly machine: (work: Work) => Machine.Machine.Any; readonly actions: ReadonlyArray<Action> }
      > = {
        "done": {
          machine: (work) => makeLoader(work),
          actions: [sends(Event.Load({ id: "a" })), ends(0, Exit.succeed("document a"))]
        },
        "a typed failure": {
          machine: (work) => makeLoader(work),
          actions: [sends(Event.Load({ id: "a" })), ends(0, Exit.fail({ reason: "not found" }))]
        },
        "a stale result": {
          machine: (work) => makeLoader(work),
          actions: [
            sends(Event.Load({ id: "a" })),
            sends(Event.Reload()),
            ends(0, Exit.succeed("stale")),
            sends(Event.Note()),
            ends(1, Exit.succeed("fresh")),
            sends(Event.Load({ id: "b" })),
            sends(Event.Cancel()),
            ends(2, Exit.succeed("late"))
          ]
        },
        "an unhandled failure": {
          machine: makeUnhandled,
          actions: [sends(Event.Load({ id: "a" })), ends(0, Exit.fail({ reason: "not found" }))]
        },
        "a defect": {
          machine: makeUnhandled,
          actions: [sends(Event.Load({ id: "a" })), ends(0, Exit.die(new Error("broken")))]
        },
        "an end that stays": {
          machine: makeStays,
          actions: [
            sends(Event.Load({ id: "a" })),
            ends(0, Exit.succeed("first")),
            ends(1, Exit.succeed("second"))
          ]
        },
        "an end that stays in a state that is entered again": {
          machine: makeStays,
          actions: [
            sends(Event.Load({ id: "a" })),
            ends(0, Exit.succeed("first")),
            sends(Event.Cancel()),
            sends(Event.Load({ id: "b" })),
            ends(2, Exit.fail({ reason: "handled" })),
            ends(3, Exit.succeed("second"))
          ]
        },
        "a final state": {
          machine: (work) => makeLoader(work),
          actions: [sends(Event.Load({ id: "a" })), sends(Event.Finish()), ends(0, Exit.succeed("late"))]
        }
      }
      const perform = (work: Work, actions: ReadonlyArray<Action>, send: (event: object) => Effect.Effect<unknown>) =>
        Effect.forEach(actions, (action) =>
          Effect.andThen(
            action._tag === "Send" ? send(action.event) : Deferred.done(work.runs[action.run]!.result, action.exit),
            settle
          ))
      /** The states a host went through, without repeating one it stayed in. */
      const sequence = (states: ReadonlyArray<readonly [status: string, active: unknown]>): ReadonlyArray<string> =>
        states.map((state) => JSON.stringify(state)).filter((state, index, all) => state !== all[index - 1])

      for (const [name, { actions, machine }] of Object.entries(scenarios)) {
        it.effect(`goes through the same states with ${name}`, () =>
          Effect.gen(function*() {
            const localWork = makeWork()
            const localMachine = machine(localWork) as Machine.Machine<any, any, any, never, never, never>
            const localStates: Array<readonly [string, unknown]> = []
            const ref = yield* LocalMachine.start(localMachine as any) as Effect.Effect<
              Machine.MachineRef<any, any, any, any>
            >
            const observer = yield* Effect.forkChild(
              Stream.runForEach(ref.changes, ({ state, status }) =>
                Effect.map(
                  Effect.orDie(Machine.encodeSnapshot(localMachine as any, state)) as Effect.Effect<any>,
                  ({ active }) => {
                    localStates.push([status === "error" ? "failed" : "active", active])
                  }
                )),
              { startImmediately: true }
            )
            yield* settle
            yield* perform(localWork, actions, (event) => Effect.exit(ref.send(event)))
            yield* Fiber.interrupt(observer)

            const clusterWork = makeWork()
            const clusterStates = yield* run(machine(clusterWork), {}, ({ send, storage }) =>
              Effect.gen(function*() {
                yield* perform(clusterWork, actions, send)
                return storage.history.map(({ snapshot, status }) =>
                  [status._tag === "Failed" ? "failed" : "active", snapshot.active] as const
                )
              }))
            // A Cluster machine plans its initial state together with its first
            // event, so the state it waits in before that is never stored.
            assert.deepStrictEqual(sequence(clusterStates), sequence(localStates).slice(1))
            assert.deepStrictEqual(
              clusterWork.runs.map(({ input, stopped }) => [input, stopped]),
              localWork.runs.map(({ input, stopped }) => [input, stopped])
            )
          }))
      }
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
          machineId: "Worker",
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
