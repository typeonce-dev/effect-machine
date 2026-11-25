import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Schema } from "effect"
import {
  EntityId,
  MessageStorage,
  RunnerHealth,
  Runners,
  RunnerStorage,
  Sharding,
  ShardingConfig,
  SqlMessageStorage
} from "effect/cluster"
import { Digest } from "effect/crypto"
import { TestClock } from "effect/testing"
import { Machine } from "../../../src/index.js"
import { ClusterMachine, SqlMachineStorage } from "../../../src/unstable/cluster/index.js"
import { config, makeTestStorage } from "./support/harness.js"

const Events = Machine.events({
  Add: { by: Schema.Number },
  Finish: {},
  RunEffect: {},
  FailWork: {}
})

const childMachine = Machine.make({
  id: "ShardChild",
  root: Machine.state({ states: { Open: {}, Done: { type: "final", output: Schema.String } } }),
  events: Machine.events({ Complete: {} })
}).handle({
  initial: { target: "Open" },
  states: {
    Open: { on: { Complete: { target: "Done" } } },
    Done: { output: () => "child-done" }
  }
})

const Child = Machine.child("child", childMachine)

const jobMachine = Machine.make({
  id: "OptionsJob",
  root: Machine.state({
    states: {
      Open: { fields: { total: Schema.Number } },
      Working: { fields: { total: Schema.Number } },
      Failing: {},
      Done: { type: "final", fields: { total: Schema.Number }, output: Schema.Number }
    }
  }),
  events: Events,
  effects: {
    compute: Effect.succeed(10),
    boom: Effect.die(new Error("work boom"))
  },
  children: { child: Child }
}).handle({
  initial: { target: "Open", data: { total: 0 } },
  states: {
    Open: {
      on: {
        Add: { update: { Open: ({ event, state }) => ({ total: state.total + event.by }) } },
        Finish: { target: "Done", data: ({ state }) => ({ total: state.total }) },
        RunEffect: { target: "Working", data: ({ state }) => ({ total: state.total }) },
        FailWork: { target: "Failing" }
      }
    },
    Working: {
      invoke: {
        src: "compute",
        onDone: { target: "Done", data: ({ output, state }) => ({ total: state.total + output }) }
      }
    },
    Failing: {
      invoke: { src: "boom" }
    },
    Done: {
      output: ({ state }) => state.total
    }
  }
})

const parentWithChild = Machine.make({
  id: "ShardedParent",
  root: Machine.state({
    states: {
      Idle: {},
      Running: {},
      Done: { type: "final", output: Schema.String }
    }
  }),
  events: Machine.events({ Begin: {}, CompleteChild: {} }),
  children: { child: Child }
}).handle({
  initial: { target: "Idle" },
  states: {
    Idle: { on: { Begin: { target: "Running" } } },
    Running: {
      invoke: { src: "child", onDone: { target: "Done" } },
      on: { CompleteChild: { stay: true, commands: (_, enqueue) => enqueue.sendTo(Child, { _tag: "Complete" }) } }
    },
    Done: { output: () => "parent-done" }
  }
})

const settle = Effect.forEach(Array.from({ length: 100 }), () => Effect.yieldNow, { discard: true })

describe("ClusterMachine options and onCommit", () => {
  it.effect("routes entities and child entities using shardGroup", () =>
    Effect.gen(function*() {
      const shardGroup = (entityId: EntityId.EntityId) => entityId.startsWith("eu:") ? "eu" : "us"
      const Parent = ClusterMachine.make("ShardedParent", parentWithChild, {
        version: "1",
        shardGroup
      })
      assert.strictEqual(Parent.entity.getShardGroup(EntityId.make("eu:order-1")), "eu")
      assert.strictEqual(Parent.entity.getShardGroup(EntityId.make("us:order-2")), "us")

      const storage = makeTestStorage()
      const layer = Parent.toLayer().pipe(
        Layer.provide(Layer.succeed(ClusterMachine.Storage, storage.service)),
        Layer.provideMerge(Sharding.layer),
        Layer.provide(Runners.layerNoop),
        Layer.provide(MessageStorage.layerMemory),
        Layer.provide(RunnerStorage.layerMemory),
        Layer.provide(RunnerHealth.layerNoop),
        Layer.provide(ShardingConfig.layer({
          availableShardGroups: ["eu", "us"],
          assignedShardGroups: ["eu", "us"],
          entityMailboxCapacity: 10,
          entityMaxIdleTime: "10 minutes",
          entityTerminationTimeout: 0,
          entityMessagePollInterval: 5000,
          sendRetryInterval: 100,
          refreshAssignmentsInterval: 0
        }))
      )

      yield* Effect.gen(function*() {
        yield* TestClock.adjust(1)
        const makeClient = yield* Parent.client
        const eu = makeClient("eu:order-1")
        const us = makeClient("us:order-2")

        yield* eu.send({ _tag: "Begin" })
        yield* us.send({ _tag: "Begin" })
        yield* eu.send({ _tag: "CompleteChild" })
        yield* settle

        const euSnap = Option.getOrThrow(yield* eu.snapshot)
        assert.strictEqual(euSnap.status, "done")
        const usSnap = Option.getOrThrow(yield* us.snapshot)
        assert.strictEqual(usSnap.status, "active")
      }).pipe(
        Effect.provide(layer),
        Effect.provideService(ClusterMachine.Storage, storage.service)
      )
    }).pipe(Effect.scoped))

  it.effect("forwards Entity.toLayer options such as maxIdleTime to passivate idle entities", () =>
    Effect.gen(function*() {
      const Job = ClusterMachine.make("IdleJob", jobMachine, { version: "1" })
      const storage = makeTestStorage()
      const layer = Job.toLayer({
        maxIdleTime: "5 seconds",
        concurrency: 1,
        mailboxCapacity: 16,
        disableFatalDefects: false,
        spanAttributes: { service: "jobs" }
      }).pipe(
        Layer.provide(Layer.succeed(ClusterMachine.Storage, storage.service)),
        Layer.provideMerge(Sharding.layer),
        Layer.provide(Runners.layerNoop),
        Layer.provide(MessageStorage.layerMemory),
        Layer.provide(RunnerStorage.layerMemory),
        Layer.provide(RunnerHealth.layerNoop),
        Layer.provide(config("10 minutes"))
      )

      yield* Effect.gen(function*() {
        yield* TestClock.adjust(1)
        const client = (yield* Job.client)("job-idle")
        yield* client.send(Events.Add({ by: 1 }))
        // First request loads from storage once (1), second request uses in-memory cache (still 1).
        yield* client.send(Events.Add({ by: 2 }))
        assert.strictEqual(storage.loads, 1)

        // Advance past entity-level maxIdleTime (5s) and EntityReaper resolution (5s),
        // well below ShardingConfig's 10-minute default.
        yield* TestClock.adjust("5 seconds")
        yield* settle
        yield* TestClock.adjust("5 seconds")
        yield* settle

        // After passivation, the next request recreates the entity and reloads from storage.
        yield* client.send(Events.Add({ by: 3 }))
        assert.isAtLeast(storage.loads, 2)
        const snap = Option.getOrThrow(yield* client.snapshot)
        assert.strictEqual(snap.revision, 3)
      }).pipe(
        Effect.provide(layer),
        Effect.provideService(ClusterMachine.Storage, storage.service)
      )
    }).pipe(Effect.scoped))

  it.effect("invokes onCommit for active, done, and failed checkpoints and retries on background failure", () =>
    Effect.gen(function*() {
      const Job = ClusterMachine.make("CommitJob", jobMachine, { version: "1" })
      const seen: Array<
        { readonly entityId: string; readonly revision: number; readonly status: string; readonly output?: number }
      > = []
      let failOnceOnDone = true

      // Use transactional SQLite storage so a failed onCommit on a background
      // invocation rolls back the checkpoint and retries cleanly.
      const layer = Job.toLayer({
        onCommit: ({ checkpoint, entityId, snapshot }) =>
          Effect.gen(function*() {
            if (entityId === "job-effect" && snapshot.status === "done" && failOnceOnDone) {
              failOnceOnDone = false
              return yield* Effect.fail("transient projection failure")
            }
            seen.push({
              entityId,
              revision: checkpoint.revision,
              status: snapshot.status,
              ...(snapshot.status === "done" ? { output: snapshot.output } : {})
            })
          })
      }).pipe(
        Layer.provideMerge(Sharding.layer),
        Layer.provide(Runners.layerNoop),
        Layer.provideMerge(SqlMessageStorage.layer),
        Layer.provideMerge(SqlMachineStorage.layer),
        Layer.provide(RunnerStorage.layerMemory),
        Layer.provide(RunnerHealth.layerNoop),
        Layer.provide(config()),
        Layer.provide(Digest.layerWebCrypto),
        Layer.provide(SqliteClient.layer({ filename: ":memory:" }))
      )

      yield* Effect.gen(function*() {
        yield* TestClock.adjust(1)
        const makeClient = yield* Job.client

        // Active + done transitions from requests.
        const direct = makeClient("job-direct")
        yield* direct.send(Events.Add({ by: 5 }))
        yield* direct.send(Events.Finish())

        // Invoked effect completes -> onCommit fails once (rolling back rev 3),
        // retries after 1s, and commits rev 3 without failing the machine.
        const effectJob = makeClient("job-effect")
        yield* effectJob.send(Events.Add({ by: 2 }))
        yield* effectJob.send(Events.RunEffect())
        yield* settle
        yield* TestClock.adjust("2 seconds")
        yield* settle
        const effectSnap = Option.getOrThrow(yield* effectJob.snapshot)
        assert.strictEqual(effectSnap.status, "done")
        if (effectSnap.status === "done") assert.strictEqual(effectSnap.output, 12)

        // Failed machine -> onCommit observes status: "failed".
        const failing = makeClient("job-fail")
        yield* failing.send(Events.FailWork())
        yield* settle
        const failSnap = Option.getOrThrow(yield* failing.snapshot)
        assert.strictEqual(failSnap.status, "failed")

        assert.deepStrictEqual(
          seen.filter((e) => e.entityId === "job-direct"),
          [
            { entityId: "job-direct", revision: 1, status: "active" },
            { entityId: "job-direct", revision: 2, status: "done", output: 5 }
          ]
        )
        assert.deepStrictEqual(
          seen.filter((e) => e.entityId === "job-effect"),
          [
            { entityId: "job-effect", revision: 1, status: "active" },
            { entityId: "job-effect", revision: 2, status: "active" },
            { entityId: "job-effect", revision: 3, status: "done", output: 12 }
          ]
        )
        assert.deepStrictEqual(
          seen.filter((e) => e.entityId === "job-fail"),
          [
            { entityId: "job-fail", revision: 1, status: "active" },
            { entityId: "job-fail", revision: 2, status: "failed" }
          ]
        )
      }).pipe(Effect.provide(layer))
    }).pipe(Effect.scoped))
})
