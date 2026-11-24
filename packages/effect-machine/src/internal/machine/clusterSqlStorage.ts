/** Durable checkpoint storage for Cluster machines in a SQL database. */
import { ClusterError, Snowflake } from "effect/cluster"
import type { EntityAddress } from "effect/cluster"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Migrator from "effect/sql/Migrator"
import * as SqlClient from "effect/sql/SqlClient"
import type { Checkpoint } from "../../unstable/cluster/ClusterMachine.js"
import { CommitResult, Storage } from "./clusterProtocol.js"

type EntityAddress = EntityAddress.EntityAddress

export interface Options {
  readonly prefix?: string | undefined
}

const defaultPrefix = "cluster_machine"

const tables = (options: Options | undefined) => {
  const prefix = options?.prefix ?? defaultPrefix
  return {
    checkpoints: `${prefix}_checkpoints`,
    requests: `${prefix}_requests`,
    migrations: `${prefix}_migrations`
  }
}

const unsupportedDialect = (dialect: string) =>
  Effect.die(new Error(`SqlMachineStorage supports PostgreSQL and SQLite, not ${dialect}`))

export const migrations = (options?: Options): Migrator.Loader => {
  const names = tables(options)
  return Migrator.fromRecord({
    "0001_create_tables": Effect.gen(function*() {
      const sql = (yield* SqlClient.SqlClient).withoutTransforms()
      if (sql.onDialectOrElse({ orElse: () => true, pg: () => false, sqlite: () => false })) {
        return yield* unsupportedDialect(
          sql.onDialectOrElse({ orElse: () => "this dialect", mysql: () => "MySQL", mssql: () => "SQL Server" })
        )
      }
      // The text of a request id keeps its 64 bits on every driver.
      yield* sql`
        CREATE TABLE IF NOT EXISTS ${sql(names.checkpoints)} (
          entity_type VARCHAR(150) NOT NULL,
          entity_id VARCHAR(255) NOT NULL,
          revision BIGINT NOT NULL,
          checkpoint TEXT NOT NULL,
          PRIMARY KEY (entity_type, entity_id)
        )
      `
      yield* sql`
        CREATE TABLE IF NOT EXISTS ${sql(names.requests)} (
          entity_type VARCHAR(150) NOT NULL,
          entity_id VARCHAR(255) NOT NULL,
          request_id VARCHAR(20) NOT NULL,
          PRIMARY KEY (entity_type, entity_id, request_id)
        )
      `
    })
  })
}

const runMigrations = (options?: Options): Effect.Effect<void, never, SqlClient.SqlClient> =>
  Migrator.make({})({
    loader: migrations(options),
    table: tables(options).migrations
  }).pipe(Effect.asVoid, Effect.orDie)

export const layerMigrations = (options?: Options): Layer.Layer<never, never, SqlClient.SqlClient> =>
  Layer.effectDiscard(runMigrations(options))

// A checkpoint is stored as JSON. Its request id is a 64-bit integer, which
// JSON numbers do not hold, so it is stored as text.
const encode = (checkpoint: Checkpoint): string =>
  JSON.stringify(
    checkpoint.origin._tag === "Request"
      ? { ...checkpoint, origin: { _tag: "Request", requestId: String(checkpoint.origin.requestId) } }
      : checkpoint
  )

const decode = (text: string): Checkpoint => {
  const parsed = JSON.parse(text)
  const origin = parsed?.origin
  return Predicate.hasProperty(origin, "requestId") && Predicate.isString(origin.requestId)
    ? { ...parsed, origin: { ...origin, requestId: Snowflake.Snowflake(origin.requestId) } }
    : parsed
}

const persistence = <A, E, R>(effect: Effect.Effect<A, E, R>) => ClusterError.PersistenceError.refail(effect)

export const makeStorage = (options?: Options): Effect.Effect<Storage["Service"], never, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = (yield* SqlClient.SqlClient).withoutTransforms()
    if (sql.onDialectOrElse({ orElse: () => true, pg: () => false, sqlite: () => false })) {
      return yield* unsupportedDialect(
        sql.onDialectOrElse({ orElse: () => "this dialect", mysql: () => "MySQL", mssql: () => "SQL Server" })
      )
    }
    const names = tables(options)
    const checkpoints = sql(names.checkpoints)
    const requests = sql(names.requests)

    const selectCheckpoint = (address: EntityAddress) =>
      sql<{ readonly checkpoint: string }>`
        SELECT checkpoint FROM ${checkpoints}
        WHERE entity_type = ${address.entityType} AND entity_id = ${address.entityId}
      `.pipe(Effect.map((rows) => Option.map(Option.fromNullishOr(rows[0]), (row) => decode(row.checkpoint))))

    const processed = (address: EntityAddress, requestId: Snowflake.Snowflake) =>
      sql`
        SELECT 1 AS found FROM ${requests}
        WHERE entity_type = ${address.entityType} AND entity_id = ${address.entityId}
          AND request_id = ${String(requestId)}
      `.pipe(Effect.map((rows) => rows.length > 0))

    // Writes the checkpoint only over the revision before it, and reports
    // whether it did. Concurrent writers of one entity meet on its row.
    const write = (address: EntityAddress, checkpoint: Checkpoint) => {
      const text = encode(checkpoint)
      return (checkpoint.revision === 1
        ? sql`
          INSERT INTO ${checkpoints} (entity_type, entity_id, revision, checkpoint)
          VALUES (${address.entityType}, ${address.entityId}, ${checkpoint.revision}, ${text})
          ON CONFLICT DO NOTHING
          RETURNING revision
        `
        : sql`
          UPDATE ${checkpoints} SET revision = ${checkpoint.revision}, checkpoint = ${text}
          WHERE entity_type = ${address.entityType} AND entity_id = ${address.entityId}
            AND revision = ${checkpoint.revision - 1}
          RETURNING revision
        `).pipe(Effect.map((rows) => rows.length > 0))
    }

    const commit = Effect.fnUntraced(function*(address: EntityAddress, checkpoint: Checkpoint) {
      const { origin } = checkpoint
      const request = origin._tag === "Request" ? origin.requestId : undefined
      if (request !== undefined && (yield* processed(address, request))) return CommitResult.Duplicate()
      if (!(yield* write(address, checkpoint))) {
        // A writer that got there first may have committed this very request,
        // which makes this commit a duplicate rather than a conflict.
        return request !== undefined && (yield* processed(address, request))
          ? CommitResult.Duplicate()
          : CommitResult.RevisionConflict()
      }
      if (request !== undefined) {
        yield* sql`
          INSERT INTO ${requests} (entity_type, entity_id, request_id)
          VALUES (${address.entityType}, ${address.entityId}, ${String(request)})
        `
      }
      return CommitResult.Committed()
    })

    return Storage.of({
      load: (address) => persistence(selectCheckpoint(address)),
      // One transaction gives both answers from one view of the store.
      loadForRequest: (address, requestId) =>
        Effect.all({
          checkpoint: selectCheckpoint(address),
          processed: processed(address, requestId)
        }).pipe(sql.withTransaction, persistence),
      // Inside the transaction of `MessageStorage` over the same client, this
      // joins it, so the checkpoint commits or rolls back with the step.
      commit: (address, checkpoint) =>
        Effect.suspend(() => commit(address, checkpoint)).pipe(sql.withTransaction, persistence)
    })
  })

export const make = (options?: Options): Effect.Effect<Storage["Service"], never, SqlClient.SqlClient> =>
  Effect.andThen(runMigrations(options), makeStorage(options))

export const layerStorage = (options?: Options): Layer.Layer<Storage, never, SqlClient.SqlClient> =>
  Layer.effect(Storage, makeStorage(options))

export const layerWith = (options: Options): Layer.Layer<Storage, never, SqlClient.SqlClient> =>
  Layer.effect(Storage, make(options))

export const layer: Layer.Layer<Storage, never, SqlClient.SqlClient> = layerWith({})
