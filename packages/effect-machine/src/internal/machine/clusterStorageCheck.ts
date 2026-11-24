/** A check that a `Storage` keeps the contract that Cluster machines rely on. */
import { EntityAddress, EntityId, EntityType, ShardId, Snowflake } from "effect/cluster"
import type { ClusterError } from "effect/cluster"
import * as Effect from "effect/Effect"
import * as Equal from "effect/Equal"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { Checkpoint } from "../../unstable/cluster/ClusterMachine.js"
import type { CommitResult, Storage } from "./clusterProtocol.js"

export class StorageCheckFailure extends Schema.TaggedError<StorageCheckFailure>(
  "effect/cluster/ClusterMachine/StorageCheckFailure"
)("StorageCheckFailure", {
  scenario: Schema.String,
  message: Schema.String
}) {}

export interface CheckOptions {
  readonly withTransaction?: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

type Service = Storage["Service"]
type Failure = StorageCheckFailure | ClusterError.PersistenceError

const run = Math.random().toString(36).slice(2, 10)
let entities = 0

const freshAddress = (entityType = "StorageCheck") =>
  EntityAddress.make({
    shardId: ShardId.make("default", 1),
    entityType: EntityType.make(entityType),
    entityId: EntityId.make(`check-${run}-${++entities}`)
  })

const request = (id: number | string): Checkpoint.Origin => ({ _tag: "Request", requestId: Snowflake.Snowflake(id) })
const timers: Checkpoint.Origin = { _tag: "Timers" }
const invocation: Checkpoint.Origin = { _tag: "Invocation", path: "Working", id: "load" }

const checkpoint = (revision: number, origin: Checkpoint.Origin, status?: Checkpoint.Status): Checkpoint => ({
  definitionId: "storage-check",
  version: "1",
  revision,
  origin,
  snapshot: { path: "", value: { revision }, children: [] } as unknown as Checkpoint["snapshot"],
  status: status ?? { _tag: "Active", invocations: {} }
})

const same = (left: unknown, right: unknown): boolean =>
  typeof left === "bigint" || typeof right === "bigint"
    ? left === right
    : Array.isArray(left) && Array.isArray(right)
    ? left.length === right.length && left.every((value, index) => same(value, right[index]))
    : typeof left === "object" && left !== null && typeof right === "object" && right !== null
    ? Object.keys(left).length === Object.keys(right).length &&
      Object.entries(left).every(([key, value]) => same(value, (right as Record<string, unknown>)[key]))
    : Equal.equals(left, right)

const scenario = (name: string, body: (storage: Service, options: CheckOptions) => Effect.Effect<void, Failure>) => ({
  name,
  body
})

const failWith = (name: string) => (message: string) => new StorageCheckFailure({ scenario: name, message })

const expectResult = (
  name: string,
  what: string,
  actual: CommitResult,
  expected: CommitResult["_tag"]
): Effect.Effect<void, StorageCheckFailure> =>
  actual._tag === expected
    ? Effect.void
    : Effect.fail(failWith(name)(`Expected ${what} to be ${expected}, received ${actual._tag}`))

const expectStored = Effect.fnUntraced(function*(
  name: string,
  storage: Service,
  address: EntityAddress.EntityAddress,
  expected: Checkpoint | undefined
) {
  const loaded = yield* storage.load(address)
  if (expected === undefined) {
    if (Option.isSome(loaded)) return yield* failWith(name)("Expected no checkpoint, received one")
    return
  }
  if (Option.isNone(loaded)) return yield* failWith(name)(`Expected revision ${expected.revision}, received none`)
  if (!same(loaded.value, expected)) {
    return yield* failWith(name)(
      `Expected the checkpoint of revision ${expected.revision} unchanged, received revision ${loaded.value.revision}`
    )
  }
})

const scenarios = [
  scenario("loads nothing for an entity without a checkpoint", (storage) =>
    Effect.gen(function*() {
      const name = "loads nothing for an entity without a checkpoint"
      const address = freshAddress()
      yield* expectStored(name, storage, address, undefined)
      const loaded = yield* storage.loadForRequest(address, Snowflake.Snowflake(1))
      if (Option.isSome(loaded.checkpoint) || loaded.processed) {
        return yield* failWith(name)("Expected no checkpoint and no processed request")
      }
    })),
  scenario("stores every field of a checkpoint unchanged", (storage) =>
    Effect.gen(function*() {
      const name = "stores every field of a checkpoint unchanged"
      const address = freshAddress()
      const first = checkpoint(1, request("9007199254740993"), {
        _tag: "Active",
        invocations: { Working: { load: { _tag: "Waiting", dueAt: 1_764_000_000_000 }, poll: { _tag: "Settled" } } }
      })
      yield* expectResult(name, "the first commit", yield* storage.commit(address, first), "Committed")
      yield* expectStored(name, storage, address, first)
      const failed = checkpoint(2, invocation, { _tag: "Failed", failure: "The machine failed" })
      yield* expectResult(name, "the second commit", yield* storage.commit(address, failed), "Committed")
      yield* expectStored(name, storage, address, failed)
    })),
  scenario("commits only the revision after the stored one", (storage) =>
    Effect.gen(function*() {
      const name = "commits only the revision after the stored one"
      const address = freshAddress()
      yield* expectResult(
        name,
        "revision 2 of no checkpoint",
        yield* storage.commit(address, checkpoint(2, timers)),
        "RevisionConflict"
      )
      const first = checkpoint(1, request(1))
      yield* expectResult(name, "revision 1", yield* storage.commit(address, first), "Committed")
      yield* expectResult(
        name,
        "revision 1 again",
        yield* storage.commit(address, checkpoint(1, timers)),
        "RevisionConflict"
      )
      yield* expectResult(name, "revision 3", yield* storage.commit(address, checkpoint(3, timers)), "RevisionConflict")
      yield* expectStored(name, storage, address, first)
      const second = checkpoint(2, timers)
      yield* expectResult(name, "revision 2", yield* storage.commit(address, second), "Committed")
      yield* expectStored(name, storage, address, second)
    })),
  scenario("treats a committed request as a duplicate before its revision", (storage) =>
    Effect.gen(function*() {
      const name = "treats a committed request as a duplicate before its revision"
      const address = freshAddress()
      const first = checkpoint(1, request(1))
      yield* expectResult(name, "the request", yield* storage.commit(address, first), "Committed")
      yield* expectResult(
        name,
        "the request at the next revision",
        yield* storage.commit(address, checkpoint(2, request(1))),
        "Duplicate"
      )
      yield* expectResult(
        name,
        "the request at a stale revision",
        yield* storage.commit(address, checkpoint(1, request(1))),
        "Duplicate"
      )
      yield* expectResult(
        name,
        "the request at a future revision",
        yield* storage.commit(address, checkpoint(5, request(1))),
        "Duplicate"
      )
      yield* expectStored(name, storage, address, first)
      const loaded = yield* storage.loadForRequest(address, Snowflake.Snowflake(1))
      if (!loaded.processed || !Option.isSome(loaded.checkpoint) || !same(loaded.checkpoint.value, first)) {
        return yield* failWith(name)("Expected the request processed, with the checkpoint it committed")
      }
      const other = yield* storage.loadForRequest(address, Snowflake.Snowflake(2))
      if (other.processed) return yield* failWith(name)("Expected another request not processed")
    })),
  scenario("records no request for a rejected commit", (storage) =>
    Effect.gen(function*() {
      const name = "records no request for a rejected commit"
      const address = freshAddress()
      yield* expectResult(name, "revision 1", yield* storage.commit(address, checkpoint(1, timers)), "Committed")
      yield* expectResult(
        name,
        "a request at a stale revision",
        yield* storage.commit(address, checkpoint(1, request(7))),
        "RevisionConflict"
      )
      const loaded = yield* storage.loadForRequest(address, Snowflake.Snowflake(7))
      if (loaded.processed) return yield* failWith(name)("Expected a conflicting request not recorded")
      yield* expectResult(
        name,
        "the request at the next revision",
        yield* storage.commit(address, checkpoint(2, request(7))),
        "Committed"
      )
    })),
  scenario("never treats a commit without a request as a duplicate", (storage) =>
    Effect.gen(function*() {
      const name = "never treats a commit without a request as a duplicate"
      const address = freshAddress()
      yield* expectResult(name, "an invocation", yield* storage.commit(address, checkpoint(1, invocation)), "Committed")
      yield* expectResult(
        name,
        "the same invocation",
        yield* storage.commit(address, checkpoint(2, invocation)),
        "Committed"
      )
      yield* expectResult(name, "timers", yield* storage.commit(address, checkpoint(3, timers)), "Committed")
      yield* expectResult(name, "timers again", yield* storage.commit(address, checkpoint(4, timers)), "Committed")
    })),
  scenario("keeps entities of other ids and types apart", (storage) =>
    Effect.gen(function*() {
      const name = "keeps entities of other ids and types apart"
      const address = freshAddress()
      const sameId = EntityAddress.make({
        shardId: address.shardId,
        entityType: EntityType.make("StorageCheckOther"),
        entityId: address.entityId
      })
      const first = checkpoint(1, request(1))
      yield* expectResult(name, "the first entity", yield* storage.commit(address, first), "Committed")
      yield* expectStored(name, storage, sameId, undefined)
      yield* expectResult(
        name,
        "the same id of another type",
        yield* storage.commit(sameId, checkpoint(1, request(1))),
        "Committed"
      )
      const other = freshAddress()
      yield* expectResult(name, "another id", yield* storage.commit(other, checkpoint(1, request(1))), "Committed")
      yield* expectStored(name, storage, address, first)
    })),
  scenario("lets one of two concurrent commits of a revision win", (storage) =>
    Effect.gen(function*() {
      const name = "lets one of two concurrent commits of a revision win"
      const address = freshAddress()
      const [left, right] = yield* Effect.all([
        storage.commit(address, checkpoint(1, request(1))),
        storage.commit(address, checkpoint(1, request(2)))
      ], { concurrency: 2 })
      const tags = [left._tag, right._tag].sort().join(" and ")
      if (tags !== "Committed and RevisionConflict") {
        return yield* failWith(name)(`Expected Committed and RevisionConflict, received ${tags}`)
      }
      const [again, duplicate] = yield* Effect.all([
        storage.commit(address, checkpoint(2, request(3))),
        storage.commit(address, checkpoint(2, request(3)))
      ], { concurrency: 2 })
      const requestTags = [again._tag, duplicate._tag].sort().join(" and ")
      if (requestTags !== "Committed and Duplicate") {
        return yield* failWith(name)(`Expected one request Committed and Duplicate, received ${requestTags}`)
      }
    })),
  scenario("rolls a commit back with the transaction around it", (storage, options) =>
    Effect.gen(function*() {
      const name = "rolls a commit back with the transaction around it"
      const withTransaction = options.withTransaction
      if (withTransaction === undefined) return
      const address = freshAddress()
      const first = checkpoint(1, request(1))
      yield* expectResult(name, "revision 1", yield* storage.commit(address, first), "Committed")
      const rolledBack = new Error("roll back")
      const exit = yield* Effect.exit(withTransaction(
        Effect.flatMap(storage.commit(address, checkpoint(2, request(2))), () => Effect.die(rolledBack))
      ))
      if (exit._tag === "Success") return yield* failWith(name)("Expected the transaction to fail")
      yield* expectStored(name, storage, address, first)
      const loaded = yield* storage.loadForRequest(address, Snowflake.Snowflake(2))
      if (loaded.processed) return yield* failWith(name)("Expected the request of a rolled back commit not recorded")
    }))
]

export const check = (storage: Service, options: CheckOptions = {}): Effect.Effect<void, Failure> =>
  Effect.forEach(scenarios, ({ body }) => body(storage, options), { discard: true })

export const scenarioNames: ReadonlyArray<string> = scenarios.map(({ name }) => name)
