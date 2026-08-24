/**
 * Local HTTP server for the Effect Machine visualizer.
 *
 * @since 0.23.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as internal from "./internal/devServer.js"
import type * as MachineRegistry from "./MachineRegistry.js"
import type * as ProjectInspector from "./ProjectInspector.js"

/**
 * @category models
 * @since 0.23.0
 */
export interface Options {
  readonly root: string
  readonly host: string
  readonly port: number
  readonly open?: boolean | undefined
  readonly debounce?: number | undefined
  readonly watchPolling?: boolean | undefined
}

/**
 * Failure while starting or serving the local visualizer.
 *
 * @category errors
 * @since 0.23.0
 */
export class DevServerError extends Schema.Error<DevServerError>(
  "@typeonce/effect-machine-devtools/DevServer/DevServerError"
)({
  _tag: Schema.tag("DevServerError"),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

/**
 * Starts the local visualizer and runs until interrupted.
 *
 * @category constructors
 * @since 0.23.0
 */
export const run = (options: Options): Effect.Effect<
  never,
  DevServerError,
  MachineRegistry.MachineRegistry | ProjectInspector.ProjectInspector
> => internal.run(DevServerError, options)
