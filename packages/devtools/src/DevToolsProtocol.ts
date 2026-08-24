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
export const protocolVersion = 1 as const

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

/**
 * JSON-safe representation of a persisted machine snapshot.
 *
 * @category schemas
 * @since 0.24.0
 */
export const EncodedSnapshot = Schema.Struct({
  _tag: Schema.Literal("MachineSnapshot"),
  active: Schema.Array(Schema.Struct({
    path: Schema.String,
    value: Schema.optionalKey(Schema.Json)
  })),
  completed: Schema.optionalKey(Schema.Array(Schema.Struct({
    path: Schema.String,
    output: Schema.optionalKey(Schema.Json)
  }))),
  history: Schema.optionalKey(Schema.Record(
    Schema.String,
    Schema.Struct({
      mode: Schema.Literals(["shallow", "deep"]),
      active: Schema.Array(Schema.String),
      values: Schema.Record(Schema.String, Schema.Json)
    })
  ))
})

/**
 * @category models
 * @since 0.24.0
 */
export type EncodedSnapshot = Schema.Schema.Type<typeof EncodedSnapshot>

const SimulationRequestFields = {
  protocolVersion: Schema.Literal(protocolVersion),
  key: Schema.String,
  revision: Schema.Natural,
  source: MachineDocument.Source
}

/**
 * Starts an isolated planner session. Omitting `input` calls a machine that
 * declares no input; otherwise the JSON value is decoded by its input schema.
 *
 * @category schemas
 * @since 0.24.0
 */
export const StartSimulation = Schema.Struct({
  ...SimulationRequestFields,
  _tag: Schema.tag("StartSimulation"),
  input: Schema.optionalKey(Schema.Json)
})

/**
 * @category models
 * @since 0.24.0
 */
export type StartSimulation = Schema.Schema.Type<typeof StartSimulation>

/**
 * Plans one JSON event from an encoded session snapshot.
 *
 * @category schemas
 * @since 0.24.0
 */
export const SendSimulationEvent = Schema.Struct({
  ...SimulationRequestFields,
  _tag: Schema.tag("SendSimulationEvent"),
  step: Schema.Natural,
  snapshot: EncodedSnapshot,
  event: Schema.Json
})

/**
 * @category models
 * @since 0.24.0
 */
export type SendSimulationEvent = Schema.Schema.Type<typeof SendSimulationEvent>

/**
 * Request accepted by the isolated machine planner.
 *
 * @category schemas
 * @since 0.24.0
 */
export const SimulationRequest = Schema.Union([StartSimulation, SendSimulationEvent])

/**
 * @category models
 * @since 0.24.0
 */
export type SimulationRequest = Schema.Schema.Type<typeof SimulationRequest>

/**
 * A compact view of one logical machine snapshot.
 *
 * @category schemas
 * @since 0.24.0
 */
export const SimulationSnapshot = Schema.Struct({
  activePaths: Schema.Array(Schema.String),
  candidateEvents: Schema.Array(Schema.String)
})

/**
 * @category models
 * @since 0.24.0
 */
export type SimulationSnapshot = Schema.Schema.Type<typeof SimulationSnapshot>

/**
 * Transition selected by the planner after hierarchy and conflict resolution.
 *
 * @category schemas
 * @since 0.24.0
 */
export const PlannedTransition = Schema.Struct({
  source: Schema.String,
  trigger: MachineDocument.Trigger,
  reenter: Schema.Boolean,
  branchIndex: Schema.Natural,
  branchKey: Schema.NullOr(Schema.String),
  target: Schema.NullOr(Schema.String),
  resolvedTarget: Schema.NullOr(Schema.String),
  updates: Schema.Array(Schema.String)
})

/**
 * @category models
 * @since 0.24.0
 */
export type PlannedTransition = Schema.Schema.Type<typeof PlannedTransition>

/**
 * Closed command produced by planning. Commands are displayed but never
 * committed by the visualizer.
 *
 * @category schemas
 * @since 0.24.0
 */
export const PlannedCommand = Schema.Union([
  Schema.Struct({
    _tag: Schema.tag("SendTo"),
    target: Schema.String,
    event: Schema.Json
  }),
  Schema.Struct({
    _tag: Schema.tag("Stop"),
    target: Schema.String
  })
])

/**
 * @category models
 * @since 0.24.0
 */
export type PlannedCommand = Schema.Schema.Type<typeof PlannedCommand>

/**
 * One statechart microstep retained in a planned macrostep.
 *
 * @category schemas
 * @since 0.24.0
 */
export const SimulationMicrostep = Schema.Struct({
  index: Schema.Natural,
  event: Schema.Json,
  transitions: Schema.Array(PlannedTransition),
  raisedEvents: Schema.Array(Schema.Json),
  emittedEvents: Schema.Array(Schema.Json),
  commands: Schema.Array(PlannedCommand),
  exitPaths: Schema.Array(Schema.String),
  entryPaths: Schema.Array(Schema.String),
  activePaths: Schema.Array(Schema.String),
  changed: Schema.Boolean
})

/**
 * @category models
 * @since 0.24.0
 */
export type SimulationMicrostep = Schema.Schema.Type<typeof SimulationMicrostep>

/**
 * Structured trace for an initial plan or one received event.
 *
 * @category schemas
 * @since 0.24.0
 */
export const SimulationFrame = Schema.Struct({
  step: Schema.Natural,
  trigger: Schema.Union([
    Schema.Struct({ _tag: Schema.tag("Initial"), input: Schema.optionalKey(Schema.Json) }),
    Schema.Struct({ _tag: Schema.tag("Event"), event: Schema.Json })
  ]),
  before: SimulationSnapshot,
  after: SimulationSnapshot,
  microsteps: Schema.Array(SimulationMicrostep),
  commands: Schema.Array(PlannedCommand),
  emittedEvents: Schema.Array(Schema.Json),
  done: Schema.Boolean,
  output: Schema.optionalKey(Schema.Json)
})

/**
 * @category models
 * @since 0.24.0
 */
export type SimulationFrame = Schema.Schema.Type<typeof SimulationFrame>

/**
 * Successful planner response containing the next portable session state.
 *
 * @category schemas
 * @since 0.24.0
 */
export const SimulationReady = Schema.Struct({
  protocolVersion: Schema.Literal(protocolVersion),
  _tag: Schema.tag("SimulationReady"),
  key: Schema.String,
  revision: Schema.Natural,
  step: Schema.Natural,
  snapshot: EncodedSnapshot,
  current: SimulationSnapshot,
  frame: SimulationFrame
})

/**
 * @category models
 * @since 0.24.0
 */
export type SimulationReady = Schema.Schema.Type<typeof SimulationReady>

/**
 * Recoverable failure produced while loading, decoding, or planning a session.
 *
 * @category schemas
 * @since 0.24.0
 */
export const SimulationFailed = Schema.Struct({
  protocolVersion: Schema.Literal(protocolVersion),
  _tag: Schema.tag("SimulationFailed"),
  key: Schema.String,
  revision: Schema.Natural,
  diagnostics: Schema.Array(Diagnostic)
})

/**
 * @category models
 * @since 0.24.0
 */
export type SimulationFailed = Schema.Schema.Type<typeof SimulationFailed>

/**
 * Result returned by the isolated machine planner.
 *
 * @category schemas
 * @since 0.24.0
 */
export const SimulationResult = Schema.Union([SimulationReady, SimulationFailed])

/**
 * @category models
 * @since 0.24.0
 */
export type SimulationResult = Schema.Schema.Type<typeof SimulationResult>
