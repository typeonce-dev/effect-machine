/**
 * Live registry of machine inspection results for one project.
 *
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type * as Stream from "effect/Stream"
import * as DevToolsProtocol from "./DevToolsProtocol.js"
import * as internal from "./internal/machineRegistry.js"
import type * as ProjectInspector from "./ProjectInspector.js"

/**
 * Current registry state sent to browser clients.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Snapshot = DevToolsProtocol.RegistrySnapshot

/**
 * @category models
 * @since 0.1.0
 */
export type Snapshot = Schema.Schema.Type<typeof Snapshot>

/**
 * @category models
 * @since 0.1.0
 */
export interface Options extends ProjectInspector.InspectOptions {
}

/**
 * Failure while starting the initial project inspection.
 *
 * @category errors
 * @since 0.1.0
 */
export class RegistryError extends Schema.Error<RegistryError>(
  "@typeonce/effect-machine-devtools/MachineRegistry/RegistryError"
)({
  _tag: Schema.tag("RegistryError"),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

/**
 * A last-known-good machine registry. Reload failures preserve the previous
 * document as a partial result while exposing the new diagnostics.
 *
 * @category services
 * @since 0.1.0
 */
export class MachineRegistry extends Context.Service<MachineRegistry, {
  readonly get: Effect.Effect<Snapshot>
  readonly changes: Stream.Stream<Snapshot>
  readonly refresh: Effect.Effect<Snapshot, RegistryError>
}>()("@typeonce/effect-machine-devtools/MachineRegistry") {}

/**
 * Builds a scoped registry that scans immediately and refreshes after relevant
 * source file changes.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (options: Options) => internal.layer({ MachineRegistry, RegistryError }, options)
