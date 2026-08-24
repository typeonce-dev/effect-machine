/**
 * Discovery and isolated evaluation of Effect Machine definitions in a project.
 *
 * @since 0.23.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type * as DevToolsProtocol from "./DevToolsProtocol.js"
import * as internal from "./internal/projectInspector.js"

/**
 * A source module containing at least one `.handle(...)` machine definition.
 *
 * @category schemas
 * @since 0.23.0
 */
export const Candidate = Schema.Struct({
  file: Schema.String,
  exportNames: Schema.Array(Schema.String)
})

/**
 * @category models
 * @since 0.23.0
 */
export type Candidate = Schema.Schema.Type<typeof Candidate>

/**
 * Options shared by discovery and inspection.
 *
 * Include and exclude entries are glob patterns relative to `root`.
 *
 * @category models
 * @since 0.23.0
 */
export interface InspectOptions {
  readonly root: string
  readonly include?: string | undefined
  readonly exclude?: ReadonlyArray<string> | undefined
  readonly revision?: number | undefined
}

/**
 * A typed failure while reading or parsing the project source tree.
 *
 * @category errors
 * @since 0.23.0
 */
export class DiscoveryError extends Schema.Error<DiscoveryError>(
  "@typeonce/effect-machine-devtools/ProjectInspector/DiscoveryError"
)({
  _tag: Schema.tag("DiscoveryError"),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

/**
 * A typed failure in the isolated evaluator itself. Failures in individual
 * project modules are returned as `DevToolsProtocol.Failed` values instead.
 *
 * @category errors
 * @since 0.23.0
 */
export class EvaluationError extends Schema.Error<EvaluationError>(
  "@typeonce/effect-machine-devtools/ProjectInspector/EvaluationError"
)({
  _tag: Schema.tag("EvaluationError"),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

/**
 * Service for locating and evaluating machine modules.
 *
 * @category services
 * @since 0.23.0
 */
export class ProjectInspector extends Context.Service<ProjectInspector, {
  readonly discover: (options: InspectOptions) => Effect.Effect<ReadonlyArray<Candidate>, DiscoveryError>
  readonly evaluate: (
    candidates: ReadonlyArray<Candidate>,
    options: InspectOptions
  ) => Effect.Effect<ReadonlyArray<DevToolsProtocol.MachineResult>, EvaluationError>
  readonly inspect: (
    options: InspectOptions
  ) => Effect.Effect<ReadonlyArray<DevToolsProtocol.MachineResult>, DiscoveryError | EvaluationError>
}>()("@typeonce/effect-machine-devtools/ProjectInspector") {}

/**
 * Discovers machine candidates with the configured inspector.
 *
 * @category combinators
 * @since 0.23.0
 */
export const discover = (options: InspectOptions): Effect.Effect<
  ReadonlyArray<Candidate>,
  DiscoveryError,
  ProjectInspector
> => Effect.flatMap(ProjectInspector, (inspector) => inspector.discover(options))

/**
 * Evaluates machine candidates with the configured inspector.
 *
 * @category combinators
 * @since 0.23.0
 */
export const evaluate = (
  candidates: ReadonlyArray<Candidate>,
  options: InspectOptions
): Effect.Effect<ReadonlyArray<DevToolsProtocol.MachineResult>, EvaluationError, ProjectInspector> =>
  Effect.flatMap(ProjectInspector, (inspector) => inspector.evaluate(candidates, options))

/**
 * Discovers and evaluates every machine candidate in a project.
 *
 * @category combinators
 * @since 0.23.0
 */
export const inspect = (options: InspectOptions): Effect.Effect<
  ReadonlyArray<DevToolsProtocol.MachineResult>,
  DiscoveryError | EvaluationError,
  ProjectInspector
> => Effect.flatMap(ProjectInspector, (inspector) => inspector.inspect(options))

/**
 * Node-backed inspector layer. Each inspection evaluates candidates inside a
 * fresh worker so a broken project module cannot corrupt the long-lived host.
 *
 * @category layers
 * @since 0.23.0
 */
export const layer = internal.layer({ ProjectInspector, DiscoveryError, EvaluationError })
