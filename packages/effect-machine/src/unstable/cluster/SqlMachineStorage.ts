/**
 * Stores the checkpoints of Cluster machines in a SQL database.
 *
 * `SqlMachineStorage` is a durable {@link ClusterMachine.Storage}. It keeps the
 * latest checkpoint of each machine and the ids of the requests it committed,
 * so a machine continues from its checkpoint after any runner restarts.
 *
 * Use the `SqlClient` that `SqlMessageStorage` uses. A step of a machine runs
 * in the transaction of `MessageStorage`, and a commit over the same client
 * joins it, so the checkpoint, the events it emits, and the reply are stored
 * together or not at all.
 *
 * `layer`, `layerWith`, and `make` run the migrations before they provide the
 * storage. To run them with another connection, such as a schema owner in a
 * deploy step, use `layerMigrations` there and `layerStorage` in the runtime.
 *
 * **Example** (Storing machines next to the messages of Cluster)
 *
 * ```ts
 * import { SqlMachineStorage } from "@typeonce/effect-machine/cluster"
 * import { SqlMessageStorage } from "effect/cluster"
 * import { Layer } from "effect"
 *
 * // Both need the same `SqlClient`, such as one from `@effect/sql-pg`.
 * const storage = Layer.mergeAll(SqlMessageStorage.layer, SqlMachineStorage.layer)
 * ```
 *
 * **Gotchas**
 *
 * PostgreSQL and SQLite are supported. Another dialect is a defect when the
 * storage or its migrations are built.
 *
 * A checkpoint is keyed by the entity type and entity id of its address, and
 * not by its shard, so a machine keeps its checkpoint when shards move.
 *
 * @since 0.48.0
 */
import type * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import type * as Migrator from "effect/sql/Migrator"
import type * as SqlClient from "effect/sql/SqlClient"
import type { Storage } from "../../internal/machine/clusterProtocol.js"
import * as internal from "../../internal/machine/clusterSqlStorage.js"

/**
 * Options of a SQL machine storage.
 *
 * **Details**
 *
 * `prefix` names the tables: `<prefix>_checkpoints`, `<prefix>_requests`, and
 * the migration history `<prefix>_migrations`. It defaults to
 * `cluster_machine`.
 *
 * **Gotchas**
 *
 * Changing `prefix` after deployment points the storage at other tables, and
 * machines start again from no checkpoint.
 *
 * @category models
 * @since 0.48.0
 */
export interface Options {
  readonly prefix?: string | undefined
}

/**
 * The migrations of a SQL machine storage, for a migrator of your own.
 *
 * @category migrations
 * @since 0.48.0
 */
export const migrations: (options?: Options) => Migrator.Loader = internal.migrations

/**
 * Creates a SQL machine storage, running its migrations first.
 *
 * @category constructors
 * @since 0.48.0
 */
export const make: (options?: Options) => Effect.Effect<Storage["Service"], never, SqlClient.SqlClient> = internal.make

/**
 * Creates a SQL machine storage without running its migrations.
 *
 * **Gotchas**
 *
 * Run `layerMigrations` with the same prefix before using it.
 *
 * @category constructors
 * @since 0.48.0
 */
export const makeStorage: (options?: Options) => Effect.Effect<Storage["Service"], never, SqlClient.SqlClient> =
  internal.makeStorage

/**
 * Provides SQL machine storage with the default tables, running the migrations
 * first.
 *
 * @category layers
 * @since 0.48.0
 */
export const layer: Layer.Layer<Storage, never, SqlClient.SqlClient> = internal.layer

/**
 * Provides SQL machine storage with a table prefix, running the migrations
 * first.
 *
 * @category layers
 * @since 0.48.0
 */
export const layerWith: (options: Options) => Layer.Layer<Storage, never, SqlClient.SqlClient> = internal.layerWith

/**
 * Runs the migrations of a SQL machine storage without providing it.
 *
 * **Details**
 *
 * Migration errors become defects. History is recorded in
 * `<prefix>_migrations`.
 *
 * @category layers
 * @since 0.48.0
 */
export const layerMigrations: (options?: Options) => Layer.Layer<never, never, SqlClient.SqlClient> =
  internal.layerMigrations

/**
 * Provides SQL machine storage without running its migrations.
 *
 * @category layers
 * @since 0.48.0
 */
export const layerStorage: (options?: Options) => Layer.Layer<Storage, never, SqlClient.SqlClient> =
  internal.layerStorage
