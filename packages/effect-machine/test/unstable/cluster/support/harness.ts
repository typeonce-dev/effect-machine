/**
 * Runs Cluster machines in memory, over storages a test can read, break, and
 * hand to another runner.
 */
import { Context, Duration, Effect, Exit, Layer, Option, Scope } from "effect"
import {
  ClusterError,
  MessageStorage,
  RunnerHealth,
  Runners,
  RunnerStorage,
  Sharding,
  ShardingConfig,
  type Snowflake
} from "effect/cluster"
import { TestClock } from "effect/testing"
import { DurableClock } from "effect/workflow"
import type { Machine } from "../../../../src/index.js"
import { ClusterMachine } from "../../../../src/unstable/cluster/index.js"

export const storageKey = (entityType: string, entityId: string): string => `${entityType}\u0000${entityId}`

/** An in-memory checkpoint store that records every commit. */
export const makeTestStorage = () => {
  const entries = new Map<string, ClusterMachine.Checkpoint>()
  const requests = new Map<string, Set<Snowflake.Snowflake>>()
  const transactionFlags: Array<boolean> = []
  const history: Array<ClusterMachine.Checkpoint> = []
  const keys: Array<string> = []
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
            keys.push(key)
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
    /** The checkpoints of one entity in `history`. */
    historyOf: (entityType: string, entityId: string) =>
      history.filter((_, index) => keys[index] === storageKey(entityType, entityId)),
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

export type TestStorage = ReturnType<typeof makeTestStorage>

export const config = (entityMaxIdleTime: Duration.Input = "10 minutes") =>
  ShardingConfig.layer({
    entityMailboxCapacity: 10,
    entityMaxIdleTime,
    entityTerminationTimeout: 0,
    entityMessagePollInterval: 5000,
    sendRetryInterval: 100,
    refreshAssignmentsInterval: 0
  })

/**
 * Sets the longest timer that waits in memory, which `ClusterMachine` reads
 * from `DurableClock` as a workflow does. A longer one is woken by a delayed
 * message instead.
 */
export const threshold = (duration: Duration.Input | undefined) =>
  duration === undefined
    ? Layer.empty
    : Layer.succeed(DurableClock.InMemoryThreshold, Duration.fromInputUnsafe(duration))

export const makeLayer = (
  bridge: ClusterMachine.ClusterMachine<any, any, never>,
  storage: ClusterMachine.Storage["Service"],
  enqueue?: (event: any) => Effect.Effect<void, unknown>,
  entityMaxIdleTime?: Duration.Input,
  overrides?: Partial<MessageStorage.MessageStorage["Service"]>,
  inMemoryThreshold?: Duration.Input
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
    Layer.provide(threshold(inMemoryThreshold)),
    Layer.provide(Layer.succeed(ClusterMachine.Storage, storage)),
    Layer.provideMerge(Sharding.layer),
    Layer.provide(Runners.layerNoop),
    Layer.provideMerge(messageStorageLayer),
    Layer.provide(RunnerStorage.layerMemory),
    Layer.provide(RunnerHealth.layerNoop),
    Layer.provide(config(entityMaxIdleTime))
  )
}

/**
 * Adapts a machine whose types do not matter to its test. Erasing them also
 * reaches the run-time check of a machine that `ClusterMachine.make` refuses at
 * compile time, as an erased machine or a JavaScript caller does.
 */
export const adapt = (
  type: string,
  machine: Machine.Machine.Any,
  ...input: ReadonlyArray<unknown>
): ClusterMachine.ClusterMachine<any, any, never> =>
  (ClusterMachine.make as any)(type, machine, { version: "1" }, ...input)

/** Message storage that outlives the runners that use it. */
export const makeMessages = Layer.build(MessageStorage.layerMemory).pipe(
  Effect.provide(config()),
  Effect.map((context) => ({
    storage: Context.get(context, MessageStorage.MessageStorage),
    driver: Context.get(context, MessageStorage.MemoryDriver)
  }))
)

/** One runner over storages that outlive it. */
export const startRunner = Effect.fnUntraced(function*(
  machine: Machine.Machine.Any,
  storage: TestStorage,
  messages: Effect.Success<typeof makeMessages>,
  options: {
    readonly input?: ReadonlyArray<unknown>
    readonly enqueue?: (event: any) => Effect.Effect<void, unknown>
    readonly idle?: Duration.Input
    readonly overrides?: Partial<MessageStorage.MessageStorage["Service"]>
    readonly runnerStorage?: Layer.Layer<RunnerStorage.RunnerStorage>
    readonly inMemoryThreshold?: Duration.Input
  } = {}
) {
  const bridge = adapt("Worker", machine, ...options.input ?? [])
  // Runners share a machine id here, and ids are unique per millisecond.
  yield* TestClock.adjust("1 second")
  const scope = yield* Scope.fork(yield* Effect.scope)
  const context = yield* bridge.toLayer(options.enqueue === undefined ? undefined : { enqueue: options.enqueue }).pipe(
    Layer.provide(threshold(options.inMemoryThreshold)),
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
  const machineClient: ClusterMachine.Client<Machine.Machine.Any> =
    (yield* Effect.provideContext(bridge.client, context))("worker-1")
  return {
    /** The client of the machine, as a caller of the adapter uses it. */
    client: machineClient,
    stored: () => storage.entries.get(storageKey("Worker", "worker-1")),
    send: (event: object): Effect.Effect<ClusterMachine.Accepted | ClusterMachine.Rejected> =>
      Effect.orDie(client.send(event as never) as Effect.Effect<any, unknown>),
    sharding: Context.get(context, Sharding.Sharding),
    stop: Scope.close(scope, Exit.void)
  }
})
