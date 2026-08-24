/**
 * Serializable inspection documents for Effect Machine devtools.
 *
 * @since 0.23.0
 */
import type { Machine } from "@typeonce/effect-machine"
import * as Schema from "effect/Schema"
import * as internal from "./internal/machineDocument.js"

/**
 * Current machine document schema version.
 *
 * @category models
 * @since 0.23.0
 */
export const schemaVersion = 2 as const

/**
 * Source module and export that produced a machine.
 *
 * @category schemas
 * @since 0.23.0
 */
export const Source = Schema.Struct({
  file: Schema.String,
  exportName: Schema.NullOr(Schema.String)
})

/**
 * @category models
 * @since 0.23.0
 */
export type Source = Schema.Schema.Type<typeof Source>

/**
 * Static target selection retained from a transition definition.
 *
 * @category schemas
 * @since 0.23.0
 */
export const Selection = Schema.Struct({
  path: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["state", "initial", "history", "choice", "update", "none"]),
  scope: Schema.NullOr(Schema.Literals(["local", "branch", "full", "initial"]))
})

/**
 * @category models
 * @since 0.23.0
 */
export type Selection = Schema.Schema.Type<typeof Selection>

/**
 * @category schemas
 * @since 0.23.0
 */
export const Initial = Schema.Struct({
  target: Schema.String,
  selection: Selection
})

/**
 * @category models
 * @since 0.23.0
 */
export type Initial = Schema.Schema.Type<typeof Initial>

/**
 * @category schemas
 * @since 0.23.0
 */
export const State = Schema.Struct({
  path: Schema.String,
  key: Schema.String,
  order: Schema.Natural,
  title: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  documentation: Schema.NullOr(Schema.String),
  type: Schema.Literals(["atomic", "compound", "parallel", "final", "history", "choice"]),
  history: Schema.NullOr(Schema.Literals(["shallow", "deep"])),
  parent: Schema.NullOr(Schema.String),
  children: Schema.Array(Schema.String),
  initial: Schema.NullOr(Schema.String),
  transitionIds: Schema.Array(Schema.String),
  activityIds: Schema.Array(Schema.String)
})

/**
 * @category models
 * @since 0.23.0
 */
export type State = Schema.Schema.Type<typeof State>

/**
 * @category schemas
 * @since 0.23.0
 */
export const Trigger = Schema.Union([
  Schema.Struct({ type: Schema.tag("event"), event: Schema.String }),
  Schema.Struct({ type: Schema.tag("always") }),
  Schema.Struct({ type: Schema.tag("done") }),
  Schema.Struct({ type: Schema.tag("choice") }),
  Schema.Struct({
    type: Schema.tag("invoke"),
    id: Schema.String,
    outcome: Schema.Literals(["element", "done", "failure", "snapshot"])
  })
])

/**
 * @category models
 * @since 0.23.0
 */
export type Trigger = Schema.Schema.Type<typeof Trigger>

const BranchFields = {
  id: Schema.String,
  target: Schema.NullOr(Schema.String),
  selection: Selection,
  updates: Schema.Array(Schema.String)
}

/**
 * @category schemas
 * @since 0.23.0
 */
export const Branch = Schema.Union([
  Schema.Struct({ ...BranchFields, type: Schema.tag("direct") }),
  Schema.Struct({
    ...BranchFields,
    type: Schema.tag("branch"),
    key: Schema.String,
    title: Schema.String
  })
])

/**
 * @category models
 * @since 0.23.0
 */
export type Branch = Schema.Schema.Type<typeof Branch>

/**
 * @category schemas
 * @since 0.23.0
 */
export const Transition = Schema.Struct({
  id: Schema.String,
  source: Schema.String,
  trigger: Trigger,
  reenter: Schema.Boolean,
  acceptance: Schema.Literals(["required", "declinable"]),
  branches: Schema.Array(Branch)
})

/**
 * @category models
 * @since 0.23.0
 */
export type Transition = Schema.Schema.Type<typeof Transition>

const ActivityFields = {
  id: Schema.String,
  source: Schema.String,
  lifecycleId: Schema.String
}

/**
 * @category schemas
 * @since 0.23.0
 */
export const Activity = Schema.Union([
  Schema.Struct({ ...ActivityFields, type: Schema.tag("process") }),
  Schema.Struct({
    ...ActivityFields,
    type: Schema.tag("effect"),
    outcomes: Schema.Struct({
      success: Schema.Literal("dynamic"),
      failure: Schema.Literals(["dynamic", "none"])
    })
  }),
  Schema.Struct({
    ...ActivityFields,
    type: Schema.tag("timer"),
    duration: Schema.String
  }),
  Schema.Struct({ ...ActivityFields, type: Schema.tag("stream") }),
  Schema.Struct({
    ...ActivityFields,
    type: Schema.tag("machine"),
    child: Schema.Struct({
      id: Schema.String,
      machineId: Schema.NullOr(Schema.String)
    })
  })
])

/**
 * @category models
 * @since 0.23.0
 */
export type Activity = Schema.Schema.Type<typeof Activity>

/**
 * @category schemas
 * @since 0.23.0
 */
export const Snapshot = Schema.Struct({
  activePaths: Schema.Array(Schema.String),
  candidateEvents: Schema.Array(Schema.String)
})

/**
 * @category models
 * @since 0.23.0
 */
export type Snapshot = Schema.Schema.Type<typeof Snapshot>

/**
 * Canonical JSON Schema used to render one machine input form.
 *
 * @category schemas
 * @since 0.24.0
 */
export const InputSchema = Schema.Struct({
  dialect: Schema.Literal("draft-2020-12"),
  schema: Schema.Json,
  definitions: Schema.Record(Schema.String, Schema.Json)
})

/**
 * @category models
 * @since 0.24.0
 */
export type InputSchema = Schema.Schema.Type<typeof InputSchema>

/**
 * Public event input paired with the schema for its payload.
 *
 * @category schemas
 * @since 0.24.0
 */
export const EventInput = Schema.Struct({
  event: Schema.String,
  schema: InputSchema
})

/**
 * @category models
 * @since 0.24.0
 */
export type EventInput = Schema.Schema.Type<typeof EventInput>

/**
 * Machine and public event inputs available to devtools forms.
 *
 * @category schemas
 * @since 0.24.0
 */
export const Inputs = Schema.Struct({
  machine: Schema.NullOr(InputSchema),
  events: Schema.Array(EventInput)
})

/**
 * @category models
 * @since 0.24.0
 */
export type Inputs = Schema.Schema.Type<typeof Inputs>

/**
 * Complete, versioned, JSON-safe machine inspection document.
 *
 * @category schemas
 * @since 0.23.0
 */
export const MachineDocument = Schema.Struct({
  schemaVersion: Schema.Literal(schemaVersion),
  revision: Schema.Natural,
  source: Schema.NullOr(Source),
  machineId: Schema.String,
  initial: Initial,
  roots: Schema.Array(Schema.String),
  states: Schema.Array(State),
  transitions: Schema.Array(Transition),
  activities: Schema.Array(Activity),
  inputs: Inputs,
  snapshot: Schema.NullOr(Snapshot)
})

/**
 * @category models
 * @since 0.23.0
 */
export type MachineDocument = Schema.Schema.Type<typeof MachineDocument>

/**
 * Options for capturing a machine document.
 *
 * @category models
 * @since 0.23.0
 */
export interface MakeOptions<M extends Machine.Machine.Any> {
  readonly revision?: number | undefined
  readonly source?: Source | undefined
  readonly snapshot?: Machine.Machine.Snapshot<Machine.Machine.States<M>> | undefined
}

/**
 * Captures every serializable definition exposed by Effect Machine inspection.
 * It never evaluates transition resolvers or activity sources.
 *
 * @category constructors
 * @since 0.23.0
 */
export const make: <M extends Machine.Machine.Any>(machine: M, options?: MakeOptions<M>) => MachineDocument =
  internal.make
