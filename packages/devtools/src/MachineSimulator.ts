/**
 * Side-effect-free, best-effort simulation over a machine document.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import * as internal from "./internal/machineSimulator.js"
import type * as MachineDocument from "./MachineDocument.js"

/**
 * Serializable state of a simulation session.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Snapshot = Schema.Struct({
  step: Schema.Natural,
  activePaths: Schema.Array(Schema.String),
  candidateEvents: Schema.Array(Schema.String)
})

/**
 * @category models
 * @since 0.1.0
 */
export type Snapshot = Schema.Schema.Type<typeof Snapshot>

/**
 * Opaque simulation state paired with its source document.
 *
 * @category models
 * @since 0.1.0
 */
export interface Session {
  readonly document: MachineDocument.MachineDocument
  readonly snapshot: Snapshot
}

/**
 * Runtime behavior deliberately skipped by a best-effort step.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Note = Schema.Literals([
  "runtime-effects-skipped",
  "state-updates-skipped",
  "reentry-lifecycles-skipped",
  "automatic-transitions-skipped"
])

/**
 * @category models
 * @since 0.1.0
 */
export type Note = Schema.Schema.Type<typeof Note>

const ResultFields = {
  event: Schema.String,
  transitionIds: Schema.Array(Schema.String),
  session: Snapshot
}

/**
 * A topologically deterministic step.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Applied = Schema.Struct({
  ...ResultFields,
  _tag: Schema.tag("Applied"),
  notes: Schema.Array(Note)
})

/**
 * @category models
 * @since 0.1.0
 */
export type Applied = Schema.Schema.Type<typeof Applied>

/**
 * An event with no registration in the current active configuration.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Blocked = Schema.Struct({
  ...ResultFields,
  _tag: Schema.tag("Blocked"),
  reason: Schema.Literal("event-not-enabled")
})

/**
 * @category models
 * @since 0.1.0
 */
export type Blocked = Schema.Schema.Type<typeof Blocked>

/**
 * A step whose topology depends on runtime behavior the document cannot safely
 * evaluate.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Indeterminate = Schema.Struct({
  ...ResultFields,
  _tag: Schema.tag("Indeterminate"),
  reason: Schema.Literals([
    "multiple-transitions",
    "declinable-transition",
    "conditional-branches",
    "history-target",
    "choice-target",
    "missing-target"
  ])
})

/**
 * @category models
 * @since 0.1.0
 */
export type Indeterminate = Schema.Schema.Type<typeof Indeterminate>

/**
 * @category schemas
 * @since 0.1.0
 */
export const StepResult = Schema.Union([Applied, Blocked, Indeterminate])

/**
 * @category models
 * @since 0.1.0
 */
export type StepResult = Schema.Schema.Type<typeof StepResult>

/**
 * Starts from the captured snapshot when present, otherwise from the static
 * initial topology.
 *
 * @category constructors
 * @since 0.1.0
 */
export const start: (document: MachineDocument.MachineDocument) => Session = internal.start

/**
 * Sends an event without running user code. `Applied` means the active topology
 * is statically known; its notes list runtime behavior that was skipped.
 *
 * @category combinators
 * @since 0.1.0
 */
export const send: (session: Session, event: string) => StepResult = internal.send
