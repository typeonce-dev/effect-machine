import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Queue, Schema, Scope, Stream } from "effect"
import {
  MessageStorage,
  RunnerHealth,
  Runners,
  RunnerStorage,
  Sharding,
  ShardingConfig,
  SqlMessageStorage
} from "effect/cluster"
import { Digest } from "effect/crypto"
import { RpcClient, RpcServer } from "effect/rpc"
import { Worker, WorkerRunner } from "effect/workers"
import { Machine } from "../../../src/index.js"
import { ClusterMachine, ClusterMachineProxy, SqlMachineStorage } from "../../../src/unstable/cluster/index.js"
import { makeMessages, makeTestStorage, storageKey, type TestStorage } from "./support/harness.js"

/**
 * Pairs a `WorkerPlatform` (main thread) and `WorkerRunnerPlatform` (worker)
 * over web-standard `MessageChannel` / `MessagePort` structured-clone
 * messaging, exercising the exact protocol used by Web Workers and
 * `SharedWorker`s.
 */
const makeMessagePortPair = () => {
  const channel = new MessageChannel()

  const clientPlatform = Worker.makePlatform<MessagePort>()({
    setup: ({ scope, worker }) =>
      Effect.as(
        Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            worker.postMessage([1])
            worker.close()
          })
        ),
        worker
      ),
    listen: ({ emit, port, scope }) => {
      const onMessage = (event: MessageEvent) => emit(event.data)
      port.addEventListener("message", onMessage)
      port.start()
      return Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          port.removeEventListener("message", onMessage)
        })
      )
    }
  })

  const serverPlatform: WorkerRunner.WorkerRunnerPlatform["Service"] = {
    start: <O = unknown, I = unknown>() =>
      Effect.gen(function*() {
        const disconnects = yield* Queue.make<number>()
        const port = channel.port2
        const sendUnsafe = (_portId: number, message: O, transfers?: ReadonlyArray<unknown>) =>
          port.postMessage([1, message], transfers as never)
        const send = (portId: number, message: O, transfers?: ReadonlyArray<unknown>) =>
          Effect.sync(() => sendUnsafe(portId, message, transfers))

        const run = <A, E, R>(
          handler: (portId: number, message: I) => Effect.Effect<A, E, R> | void
        ) =>
          Effect.scopedWith(Effect.fnUntraced(function*(scope) {
            const closeLatch = Deferred.makeUnsafe<void>()
            const trackFiber = Fiber.runIn(scope)
            const services = yield* Effect.context<R>()
            const runFork = Effect.runForkWith(services)
            const onExit = (exit: Exit.Exit<any, E>) => {
              if (exit._tag === "Failure" && !Cause.hasInterruptsOnly(exit.cause)) {
                runFork(Effect.logError("unhandled error in worker", exit.cause))
              }
            }

            const onMessage = (event: MessageEvent) => {
              const message = event.data as WorkerRunner.PlatformMessage<I>
              if (message[0] === 0) {
                const result = handler(0, message[1])
                if (Effect.isEffect(result)) {
                  const fiber = runFork(result)
                  fiber.addObserver(onExit)
                  trackFiber(fiber)
                }
              } else {
                Queue.offerUnsafe(disconnects, 0)
                Deferred.doneUnsafe(closeLatch, Exit.void)
              }
            }

            port.addEventListener("message", onMessage)
            port.start()
            yield* Scope.addFinalizer(
              scope,
              Effect.sync(() => {
                port.removeEventListener("message", onMessage)
                port.close()
              })
            )
            // Signal worker readiness, matching `BrowserWorkerRunner`.
            port.postMessage([0])
            yield* Deferred.await(closeLatch)
          }))

        return { run, send, sendUnsafe, disconnects }
      })
  }

  const clientLayer = RpcClient.layerProtocolWorker({ size: 1, concurrency: 100 }).pipe(
    Layer.provide(Layer.succeed(Worker.WorkerPlatform, clientPlatform)),
    Layer.provide(Worker.layerSpawner(() => channel.port1))
  )

  const serverLayer = RpcServer.layerProtocolWorkerRunner.pipe(
    Layer.provide(Layer.succeed(WorkerRunner.WorkerRunnerPlatform, serverPlatform))
  )

  return { clientLayer, serverLayer }
}

const shardingConfig = ShardingConfig.layer({
  shardsPerGroup: 10,
  entityMessagePollInterval: "50 millis",
  entityMailboxCapacity: 100,
  entityMaxIdleTime: "5 minutes"
})

const Events = Machine.events({
  Rename: { name: Schema.NonEmptyString },
  Add: { amount: Schema.Number },
  Finish: {},
  FailWork: {}
})
const Internal = Machine.internalEvents({ Touched: {} })

class Receipt extends Schema.Class<Receipt>("Receipt")({
  label: Schema.String,
  total: Schema.Number,
  at: Schema.DateFromString
}) {}

const counterMachine = Machine.make({
  id: "ProxyCounter",
  root: Machine.state({
    states: {
      Counting: { fields: { name: Schema.String, total: Schema.Number, updatedAt: Schema.DateFromString } },
      Failing: {},
      Done: {
        type: "final",
        fields: { name: Schema.String, total: Schema.Number, updatedAt: Schema.DateFromString },
        output: Receipt
      }
    }
  }),
  events: Events,
  internalEvents: Internal,
  effects: {
    boom: Effect.die(new Error("work exploded"))
  }
}).handle({
  initial: {
    target: "Counting",
    data: { name: "untitled", total: 0, updatedAt: new Date("2026-01-01T00:00:00.000Z") }
  },
  states: {
    Counting: {
      on: {
        Rename: {
          target: "Counting",
          data: ({ event, state }) => ({ name: event.name, total: state.total, updatedAt: state.updatedAt })
        },
        Add: {
          target: "Counting",
          data: ({ event, state }) => ({
            name: state.name,
            total: state.total + event.amount,
            updatedAt: new Date("2026-06-15T12:00:00.000Z")
          })
        },
        Finish: {
          target: "Done",
          data: ({ state }) => ({ name: state.name, total: state.total, updatedAt: state.updatedAt })
        },
        FailWork: { target: "Failing" },
        Touched: { stay: true }
      }
    },
    Failing: {
      invoke: { src: "boom" }
    },
    Done: {
      output: ({ state }) => new Receipt({ label: state.name, total: state.total, at: state.updatedAt })
    }
  }
})

const Counter = ClusterMachine.make("ProxyCounter", counterMachine, {
  version: "1",
  readInterval: "50 millis"
})

const LedgerEvents = Machine.events({ Credit: { amount: Schema.Number } })
const ledgerMachine = Machine.make({
  id: "ProxyLedger",
  root: Machine.state({ states: { Open: { fields: { balance: Schema.Number } } } }),
  events: LedgerEvents
}).handle({
  initial: { target: "Open", data: { balance: 0 } },
  states: {
    Open: {
      on: {
        Credit: { update: { Open: ({ event, state }) => ({ balance: state.balance + event.amount }) } }
      }
    }
  }
})
const Ledger = ClusterMachine.make("ProxyLedger", ledgerMachine, { version: "1", readInterval: "50 millis" })

const OrderEvents = Machine.events({ Pay: { ledgerId: Schema.String, amount: Schema.Number } })
const orderMachine = Machine.make({
  id: "ProxyOrder",
  root: Machine.state({ states: { Open: {}, Paid: { type: "final", output: Schema.Number } } }),
  events: OrderEvents
}).handle({
  initial: { target: "Open" },
  states: {
    Open: {
      on: {
        Pay: {
          target: "Paid",
          commands: ({ event }, enqueue) =>
            enqueue.sendTo(Ledger.target(event.ledgerId), { _tag: "Credit", amount: event.amount })
        }
      }
    },
    Paid: { output: () => 1 }
  }
})
const Order = ClusterMachine.make("ProxyOrder", orderMachine, { version: "1", readInterval: "50 millis" })

const startWorkerCluster = (sqlLayer: Layer.Layer<any, any>) => {
  const { clientLayer, serverLayer } = makeMessagePortPair()
  const clusterLayer = Sharding.layer.pipe(
    Layer.provideMerge(Runners.layerNoop),
    Layer.provideMerge(SqlMessageStorage.layer),
    Layer.provideMerge(SqlMachineStorage.layer),
    Layer.provide(RunnerStorage.layerMemory),
    Layer.provide(RunnerHealth.layerNoop),
    Layer.provide(shardingConfig),
    Layer.provide(Digest.layerWebCrypto),
    Layer.provide(sqlLayer)
  )
  const workerLayer = ClusterMachineProxy.toLayer(Counter).pipe(
    Layer.provide(Counter.toLayer()),
    Layer.provide(clusterLayer),
    Layer.provide(serverLayer)
  )
  return { clientLayer, workerLayer }
}

const runWorkerInFiber = <E>(workerLayer: Layer.Layer<never, E>) =>
  Effect.gen(function*() {
    const ready = yield* Deferred.make<void>()
    const fiber = yield* Layer.build(workerLayer).pipe(
      Effect.andThen(Deferred.succeed(ready, undefined)),
      Effect.andThen(Effect.never),
      Effect.scoped,
      Effect.forkScoped
    )
    yield* Deferred.await(ready)
    return fiber
  })
const overwrite = (storage: TestStorage, entityId: string, change: Partial<ClusterMachine.Checkpoint>) => {
  const key = storageKey("ProxyCounter", entityId)
  const stored = storage.entries.get(key)!
  storage.entries.set(key, { ...stored, ...change })
}

const TrialEvents = Machine.events({ Start: { ms: Schema.Number } })
const trialMachine = Machine.make({
  id: "ProxyTrial",
  root: Machine.state({
    states: {
      Inactive: {},
      Running: { fields: { ms: Schema.Number } },
      Expired: { type: "final", output: Schema.String }
    }
  }),
  events: TrialEvents,
  timers: { trial: (ms: number) => `${ms} millis` as const }
}).handle({
  initial: { target: "Inactive" },
  states: {
    Inactive: { on: { Start: { target: "Running", data: ({ event }) => ({ ms: event.ms }) } } },
    Running: { invoke: { src: "trial", input: ({ state }) => state.ms, onDone: { target: "Expired" } } },
    Expired: { output: () => "expired" }
  }
})
const Trial = ClusterMachine.make("ProxyTrial", trialMachine, { version: "1", readInterval: "25 millis" })

describe("ClusterMachineProxy", () => {
  it.live("runs a SQLite ClusterMachine over Web Worker MessagePort RPC with decoded classes, dates, changes, and join", () =>
    Effect.gen(function*() {
      const sqlLayer = SqliteClient.layer({ filename: ":memory:" })
      const { clientLayer, workerLayer } = startWorkerCluster(sqlLayer)
      yield* Layer.build(workerLayer)
      const clientContext = yield* Layer.build(clientLayer)

      // Client runs with ONLY `RpcClient.Protocol` — zero `Sharding`, zero `Storage`, zero SQL.
      const makeCounter = yield* ClusterMachineProxy.client(Counter).pipe(Effect.provide(clientContext))
      const client = makeCounter("c-1")

      assert.strictEqual(client.entityId, "c-1")
      assert.isTrue(Option.isNone(yield* client.snapshot))

      // Start streaming changes concurrently while sending events over the single worker.
      const seenFiber = yield* client.changes.pipe(
        Stream.map((snap) => `${snap.status}@${snap.revision}`),
        Stream.runCollect,
        Effect.forkChild
      )

      yield* client.send(Events.Rename({ name: "Q4" }))
      yield* client.send({ _tag: "Add", amount: 7 })

      const active = Option.getOrThrow(yield* client.snapshot)
      assert.strictEqual(active.status, "active")
      assert.strictEqual(active.revision, 2)
      assert.strictEqual(active.state.state.path, "Counting")
      if (active.state.state.path === "Counting") {
        assert.strictEqual(active.state.state.value.name, "Q4")
        assert.strictEqual(active.state.state.value.total, 7)
        // DateFromString is properly decoded back into a Date instance on the client!
        assert.instanceOf(active.state.state.value.updatedAt, Date)
        assert.strictEqual(active.state.state.value.updatedAt.toISOString(), "2026-06-15T12:00:00.000Z")
      }

      const joinFiber = yield* Effect.forkChild(client.join)
      yield* client.send(Events.Finish())

      const receipt = yield* Fiber.join(joinFiber)
      assert.instanceOf(receipt, Receipt)
      assert.strictEqual(receipt.label, "Q4")
      assert.strictEqual(receipt.total, 7)
      assert.instanceOf(receipt.at, Date)
      assert.strictEqual(receipt.at.toISOString(), "2026-06-15T12:00:00.000Z")

      const seen = yield* Fiber.join(seenFiber)
      assert.isTrue(seen.length >= 1)
      assert.strictEqual(seen.at(-1), "done@3")
    }).pipe(Effect.scoped))

  it.live("rejects invalid and internal events locally before sending over the worker wire", () =>
    Effect.gen(function*() {
      const sqlLayer = SqliteClient.layer({ filename: ":memory:" })
      const { clientLayer, workerLayer } = startWorkerCluster(sqlLayer)
      yield* Layer.build(workerLayer)
      const clientContext = yield* Layer.build(clientLayer)

      const makeCounter = yield* ClusterMachineProxy.client(Counter).pipe(Effect.provide(clientContext))
      const client = makeCounter("c-invalid")

      const badSchema = yield* Effect.flip(client.send({ _tag: "Rename", name: "" }))
      assert.strictEqual(badSchema._tag, "Rejected")
      assert.strictEqual(badSchema._tag === "Rejected" && badSchema.reason, "InvalidEvent")

      const internal = yield* Effect.flip(client.send(Internal.Touched() as never))
      assert.strictEqual(internal._tag, "Rejected")
      assert.strictEqual(internal._tag === "Rejected" && internal.reason, "InvalidEvent")

      // Nothing was committed on the worker.
      assert.isTrue(Option.isNone(yield* client.snapshot))
    }).pipe(Effect.scoped))

  it.live("propagates MachineFailedError and ReadError across the worker boundary", () =>
    Effect.gen(function*() {
      const storage = makeTestStorage()
      const messages = yield* makeMessages
      const { clientLayer, serverLayer } = makeMessagePortPair()
      const clusterLayer = Sharding.layer.pipe(
        Layer.provideMerge(Runners.layerNoop),
        Layer.provideMerge(Layer.succeed(MessageStorage.MessageStorage, messages.storage)),
        Layer.provideMerge(Layer.succeed(ClusterMachine.Storage, storage.service)),
        Layer.provide(RunnerStorage.layerMemory),
        Layer.provide(RunnerHealth.layerNoop),
        Layer.provide(shardingConfig)
      )
      const workerLayer = ClusterMachineProxy.toLayer(Counter).pipe(
        Layer.provide(Counter.toLayer()),
        Layer.provide(clusterLayer),
        Layer.provide(serverLayer)
      )
      yield* Layer.build(workerLayer)
      const clientContext = yield* Layer.build(clientLayer)

      const makeCounter = yield* ClusterMachineProxy.client(Counter).pipe(Effect.provide(clientContext))
      const failing = makeCounter("c-fail")
      yield* failing.send(Events.FailWork())

      const failed = yield* Effect.flip(failing.join)
      assert.strictEqual(failed._tag, "MachineFailedError")
      assert.include(failed._tag === "MachineFailedError" ? failed.failure : "", "work exploded")

      const versioned = makeCounter("c-1")
      yield* versioned.send(Events.Add({ amount: 1 }))
      overwrite(storage, "c-1", { version: "2" })
      const readError = yield* Effect.flip(versioned.snapshot)
      assert.strictEqual(readError._tag, "ReadError")
      assert.strictEqual(readError._tag === "ReadError" && readError.reason, "VersionMismatch")
    }).pipe(Effect.scoped))

  it.live("hosts multiple ClusterMachines on one Web Worker with transactional cross-machine sends", () =>
    Effect.gen(function*() {
      const sqlLayer = SqliteClient.layer({ filename: ":memory:" })
      const { clientLayer, serverLayer } = makeMessagePortPair()
      const clusterLayer = Sharding.layer.pipe(
        Layer.provideMerge(Runners.layerNoop),
        Layer.provideMerge(SqlMessageStorage.layer),
        Layer.provideMerge(SqlMachineStorage.layer),
        Layer.provide(RunnerStorage.layerMemory),
        Layer.provide(RunnerHealth.layerNoop),
        Layer.provide(shardingConfig),
        Layer.provide(Digest.layerWebCrypto),
        Layer.provide(sqlLayer)
      )

      const group = ClusterMachineProxy.toRpcGroup(Order).merge(ClusterMachineProxy.toRpcGroup(Ledger))
      const workerLayer = RpcServer.layer(group).pipe(
        Layer.provide(ClusterMachineProxy.layerHandlers(Order)),
        Layer.provide(ClusterMachineProxy.layerHandlers(Ledger)),
        Layer.provide(Layer.mergeAll(Order.toLayer(), Ledger.toLayer())),
        Layer.provide(clusterLayer),
        Layer.provide(serverLayer)
      )
      yield* Layer.build(workerLayer)
      const clientContext = yield* Layer.build(clientLayer)

      // Both clients share the same single-worker RpcClient.Protocol.
      const makeOrder = yield* ClusterMachineProxy.client(Order).pipe(Effect.provide(clientContext))
      const makeLedger = yield* ClusterMachineProxy.client(Ledger).pipe(Effect.provide(clientContext))

      const order = makeOrder("order-1")
      const ledger = makeLedger("ledger-1")

      yield* order.send(OrderEvents.Pay({ ledgerId: "ledger-1", amount: 42 }))
      assert.strictEqual(yield* order.join, 1)

      // Wait for the Ledger entity to commit the transactional `Credit` sent by Order.
      const ledgerSnap = yield* ledger.changes.pipe(
        Stream.take(1),
        Stream.runHead,
        Effect.map(Option.getOrThrow)
      )
      assert.strictEqual(ledgerSnap.status, "active")
      assert.strictEqual(ledgerSnap.state.state.path, "Open")
      if (ledgerSnap.state.state.path === "Open") {
        assert.strictEqual(ledgerSnap.state.state.value.balance, 42)
      }
    }).pipe(Effect.scoped))

  it.live("runs timers inside the Cluster worker and delivers the final output to the main thread", () =>
    Effect.gen(function*() {
      const sqlLayer = SqliteClient.layer({ filename: ":memory:" })
      const { clientLayer, serverLayer } = makeMessagePortPair()
      const clusterLayer = Sharding.layer.pipe(
        Layer.provideMerge(Runners.layerNoop),
        Layer.provideMerge(SqlMessageStorage.layer),
        Layer.provideMerge(SqlMachineStorage.layer),
        Layer.provide(RunnerStorage.layerMemory),
        Layer.provide(RunnerHealth.layerNoop),
        Layer.provide(shardingConfig),
        Layer.provide(Digest.layerWebCrypto),
        Layer.provide(sqlLayer)
      )
      const workerLayer = ClusterMachineProxy.toLayer(Trial).pipe(
        Layer.provide(Trial.toLayer()),
        Layer.provide(clusterLayer),
        Layer.provide(serverLayer)
      )
      yield* runWorkerInFiber(workerLayer)
      const clientContext = yield* Layer.build(clientLayer)

      const makeTrial = yield* ClusterMachineProxy.client(Trial).pipe(Effect.provide(clientContext))
      const trial = makeTrial("trial-1")

      yield* trial.send(TrialEvents.Start({ ms: 40 }))
      assert.strictEqual(yield* trial.join, "expired")
    }).pipe(Effect.scoped))

  it.live("recovers from a persisted SQLite checkpoint when a new worker boots", () =>
    Effect.gen(function*() {
      // One shared SQLite database outlives the first worker, simulating a page/worker reload.
      const sqlLayer = Layer.fresh(SqliteClient.layer({ filename: ":memory:" }))
      const sqlContext = yield* Layer.build(sqlLayer)
      const sharedSql = Layer.succeedContext(sqlContext)

      // Boot worker #1 in its own fiber, commit two events, then shut worker #1 down cleanly.
      yield* Effect.scoped(Effect.gen(function*() {
        const { clientLayer, workerLayer } = startWorkerCluster(sharedSql)
        yield* runWorkerInFiber(workerLayer)
        const clientContext = yield* Layer.build(clientLayer)
        const makeCounter = yield* ClusterMachineProxy.client(Counter).pipe(Effect.provide(clientContext))
        const client = makeCounter("reload-1")
        yield* client.send(Events.Rename({ name: "Saved" }))
        yield* client.send(Events.Add({ amount: 10 }))
      }))

      // Boot worker #2 against the same SQLite database and continue from revision 2.
      yield* Effect.scoped(Effect.gen(function*() {
        const { clientLayer, workerLayer } = startWorkerCluster(sharedSql)
        yield* runWorkerInFiber(workerLayer)
        const clientContext = yield* Layer.build(clientLayer)
        const makeCounter = yield* ClusterMachineProxy.client(Counter).pipe(Effect.provide(clientContext))
        const client = makeCounter("reload-1")

        const before = Option.getOrThrow(yield* client.snapshot)
        assert.strictEqual(before.revision, 2)

        yield* client.send(Events.Add({ amount: 5 }))
        yield* client.send(Events.Finish())
        const receipt = yield* client.join
        assert.strictEqual(receipt.label, "Saved")
        assert.strictEqual(receipt.total, 15)
      }))
    }).pipe(Effect.scoped))
})
