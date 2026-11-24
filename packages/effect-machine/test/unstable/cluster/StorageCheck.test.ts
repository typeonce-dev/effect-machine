import { assert, describe, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { EntityAddress, EntityType } from "effect/cluster"
import { CommitResult } from "../../../src/unstable/cluster/ClusterMachine.js"
import { ClusterMachine } from "../../../src/unstable/cluster/index.js"

type Service = ClusterMachine.Storage["Service"]

/** A store that breaks one rule of the contract, built over the in-memory one. */
const broken = (change: (storage: Service) => Partial<Service>) =>
  Effect.map(ClusterMachine.makeMemory, (storage): Service => ({ ...storage, ...change(storage) }))

const failure = (storage: Effect.Effect<Service>) =>
  storage.pipe(
    Effect.flatMap((service) => Effect.flip(ClusterMachine.checkStorage(service))),
    Effect.map((error) => (error._tag === "StorageCheckFailure" ? error.scenario : error._tag))
  )

describe("ClusterMachine.checkStorage", () => {
  it.effect("passes the in-memory store", () =>
    Effect.flatMap(ClusterMachine.makeMemory, (storage) => ClusterMachine.checkStorage(storage)))

  it.effect("fails a store that decides revisions before duplicates", () =>
    Effect.gen(function*() {
      const scenario = yield* failure(broken((storage) => ({
        commit: (address, checkpoint) =>
          Effect.flatMap(storage.load(address), (stored) =>
            checkpoint.revision !== (Option.isSome(stored) ? stored.value.revision : 0) + 1
              ? Effect.succeed(CommitResult.RevisionConflict())
              : storage.commit(address, checkpoint))
      })))
      assert.strictEqual(scenario, "treats a committed request as a duplicate before its revision")
    }))

  it.effect("fails a store that treats a repeated origin as a duplicate", () =>
    Effect.gen(function*() {
      const seen = new Set<string>()
      const scenario = yield* failure(broken((storage) => ({
        commit: (address, checkpoint) => {
          if (checkpoint.origin._tag !== "Invocation") return storage.commit(address, checkpoint)
          const key = `${address.entityId}/${
            JSON.stringify(checkpoint.origin, (_, value) => typeof value === "bigint" ? String(value) : value)
          }`
          if (seen.has(key)) return Effect.succeed(CommitResult.Duplicate())
          seen.add(key)
          return storage.commit(address, checkpoint)
        }
      })))
      assert.strictEqual(scenario, "never treats a commit without a request as a duplicate")
    }))

  it.effect("fails a store that keys entities by id alone", () =>
    Effect.gen(function*() {
      const scenario = yield* failure(broken((storage) => {
        const byId = (address: EntityAddress.EntityAddress) =>
          EntityAddress.make({
            shardId: address.shardId,
            entityType: EntityType.make("Any"),
            entityId: address.entityId
          })
        return {
          load: (address) => storage.load(byId(address)),
          loadForRequest: (address, id) => storage.loadForRequest(byId(address), id),
          commit: (address, checkpoint) => storage.commit(byId(address), checkpoint)
        }
      }))
      assert.strictEqual(scenario, "keeps entities of other ids and types apart")
    }))

  it.effect("fails a store that loses the precision of a request id", () =>
    Effect.gen(function*() {
      const scenario = yield* failure(broken((storage) => ({
        load: (address) =>
          Effect.map(
            storage.load(address),
            Option.map((checkpoint) =>
              checkpoint.origin._tag === "Request"
                ? {
                  ...checkpoint,
                  origin: { ...checkpoint.origin, requestId: BigInt(Number(checkpoint.origin.requestId)) as never }
                }
                : checkpoint
            )
          )
      })))
      assert.strictEqual(scenario, "stores every field of a checkpoint unchanged")
    }))

  it.effect("fails a store that does not roll back with the transaction", () =>
    Effect.gen(function*() {
      const storage = yield* ClusterMachine.makeMemory
      const error = yield* Effect.flip(ClusterMachine.checkStorage(storage, { withTransaction: (effect) => effect }))
      assert.strictEqual(
        error._tag === "StorageCheckFailure" && error.scenario,
        "rolls a commit back with the transaction around it"
      )
    }))
})
