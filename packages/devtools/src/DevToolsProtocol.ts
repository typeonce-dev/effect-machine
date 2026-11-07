/**
 * Versioned messages exchanged by Effect Machine devtools processes.
 *
 * @since 0.23.0
 */
import * as Schema from "effect/Schema"
import * as MachineDocument from "./MachineDocument.js"

/**
 * Current devtools protocol version.
 *
 * @category models
 * @since 0.23.0
 */
export const protocolVersion = 2 as const

/**
 * @category schemas
 * @since 0.23.0
 */
export const Location = Schema.Struct({
  file: Schema.String,
  line: Schema.NullOr(Schema.Natural),
  column: Schema.NullOr(Schema.Natural)
})

/**
 * @category models
 * @since 0.23.0
 */
export type Location = Schema.Schema.Type<typeof Location>

/**
 * A recoverable or terminal problem associated with one machine candidate.
 *
 * @category schemas
 * @since 0.23.0
 */
export const Diagnostic = Schema.Struct({
  severity: Schema.Literals(["warning", "error"]),
  code: Schema.String,
  message: Schema.String,
  location: Schema.NullOr(Location),
  statePath: Schema.NullOr(Schema.String)
})

/**
 * @category models
 * @since 0.23.0
 */
export type Diagnostic = Schema.Schema.Type<typeof Diagnostic>

const ResultFields = {
  protocolVersion: Schema.Literal(protocolVersion),
  key: Schema.String
}

/**
 * A complete machine inspection result.
 *
 * @category schemas
 * @since 0.23.0
 */
export const Ready = Schema.Struct({
  ...ResultFields,
  _tag: Schema.tag("Ready"),
  document: MachineDocument.MachineDocument,
  diagnostics: Schema.Array(Diagnostic)
})

/**
 * @category models
 * @since 0.23.0
 */
export type Ready = Schema.Schema.Type<typeof Ready>

/**
 * A usable document accompanied by diagnostics from an incomplete reload.
 *
 * @category schemas
 * @since 0.23.0
 */
export const Partial = Schema.Struct({
  ...ResultFields,
  _tag: Schema.tag("Partial"),
  document: MachineDocument.MachineDocument,
  diagnostics: Schema.Array(Diagnostic)
})

/**
 * @category models
 * @since 0.23.0
 */
export type Partial = Schema.Schema.Type<typeof Partial>

/**
 * A machine candidate that could not produce a document.
 *
 * @category schemas
 * @since 0.23.0
 */
export const Failed = Schema.Struct({
  ...ResultFields,
  _tag: Schema.tag("Failed"),
  source: MachineDocument.Source,
  machineId: Schema.NullOr(Schema.String),
  diagnostics: Schema.Array(Diagnostic)
})

/**
 * @category models
 * @since 0.23.0
 */
export type Failed = Schema.Schema.Type<typeof Failed>

/**
 * Schema for every result returned by discovery and evaluation.
 *
 * @category schemas
 * @since 0.23.0
 */
export const MachineResult = Schema.Union([Ready, Partial, Failed])

/**
 * @category models
 * @since 0.23.0
 */
export type MachineResult = Schema.Schema.Type<typeof MachineResult>

/**
 * The outcome of checking one exported machine. `report` is the JSON form of a
 * `MachineTest.CheckReport`.
 *
 * @category schemas
 * @since 0.47.0
 */
export const Checked = Schema.Struct({
  _tag: Schema.tag("Checked"),
  key: Schema.String,
  source: MachineDocument.Source,
  report: Schema.Json
})

/**
 * @category models
 * @since 0.47.0
 */
export type Checked = Schema.Schema.Type<typeof Checked>

/**
 * One result of checking a project: a report, or a module or machine that could
 * not be loaded.
 *
 * @category schemas
 * @since 0.47.0
 */
export const CheckResult = Schema.Union([Checked, Failed])

/**
 * @category models
 * @since 0.47.0
 */
export type CheckResult = Schema.Schema.Type<typeof CheckResult>

/**
 * A complete live-registry update sent to browser clients.
 *
 * @category schemas
 * @since 0.23.0
 */
export const RegistrySnapshot = Schema.Struct({
  protocolVersion: Schema.Literal(protocolVersion),
  revision: Schema.Natural,
  results: Schema.Array(MachineResult)
})

/**
 * @category models
 * @since 0.23.0
 */
export type RegistrySnapshot = Schema.Schema.Type<typeof RegistrySnapshot>
