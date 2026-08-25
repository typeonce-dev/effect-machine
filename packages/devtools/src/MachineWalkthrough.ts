/**
 * Side-effect-free topology walkthroughs over machine documents.
 *
 * @since 0.25.0
 */
import { dual } from "effect/Function"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as internal from "./internal/machineWalkthrough.js"
import type * as MachineDocument from "./MachineDocument.js"

const TypeId = internal.SessionTypeId

/**
 * An immutable walkthrough session. Its timeline can be inspected and its
 * cursor can move without evaluating machine callbacks.
 *
 * @category models
 * @since 0.25.0
 */
export interface Session {
  readonly [TypeId]: typeof TypeId
}

/**
 * Why taking a documented branch requires an explicit human decision.
 *
 * @category models
 * @since 0.25.0
 */
export type Decision =
  | "conditional-branch"
  | "declinable-transition"
  | "automatic-trigger"
  | "invoke-outcome"

/**
 * Why a documented branch cannot advance topology without runtime data.
 *
 * @category models
 * @since 0.25.0
 */
export type UnavailableReason = "history-unavailable" | "runtime-target"

/**
 * One branch that can be explored from the current active configuration.
 *
 * @category models
 * @since 0.25.0
 */
export interface Choice {
  readonly id: string
  readonly transitionId: string
  readonly branchId: string
  readonly branchIndex: number
  readonly branchKey: string | null
  readonly title: string | null
  readonly source: string
  readonly trigger: MachineDocument.Trigger
  readonly target: string | null
  readonly selection: MachineDocument.Selection
  readonly updates: ReadonlyArray<string>
  readonly decisions: ReadonlyArray<Decision>
  readonly unavailableReason: UnavailableReason | null
  readonly input: MachineDocument.InputSchema | null
}

/**
 * The active state paths at one point in a walkthrough.
 *
 * @category models
 * @since 0.25.0
 */
export interface Snapshot {
  readonly activePaths: ReadonlyArray<string>
}

/**
 * One initial or manually selected topology step.
 *
 * @category models
 * @since 0.25.0
 */
export interface Frame {
  readonly step: number
  readonly choice: Choice | null
  readonly before: Snapshot
  readonly after: Snapshot
  readonly exitPaths: ReadonlyArray<string>
  readonly entryPaths: ReadonlyArray<string>
  readonly changed: boolean
}

/**
 * A requested choice is not available from the cursor's configuration.
 *
 * @category errors
 * @since 0.25.0
 */
export class ChoiceNotFound extends Schema.Error<ChoiceNotFound>(
  "@typeonce/effect-machine-devtools/MachineWalkthrough/ChoiceNotFound"
)({
  _tag: Schema.tag("ChoiceNotFound"),
  choiceId: Schema.String
}) {}

/**
 * A choice depends on runtime information absent from the machine document.
 *
 * @category errors
 * @since 0.25.0
 */
export class ChoiceUnavailable extends Schema.Error<ChoiceUnavailable>(
  "@typeonce/effect-machine-devtools/MachineWalkthrough/ChoiceUnavailable"
)({
  _tag: Schema.tag("ChoiceUnavailable"),
  choiceId: Schema.String,
  reason: Schema.Literals(["history-unavailable", "runtime-target"])
}) {}

/**
 * A requested timeline step does not exist.
 *
 * @category errors
 * @since 0.25.0
 */
export class StepNotFound extends Schema.Error<StepNotFound>(
  "@typeonce/effect-machine-devtools/MachineWalkthrough/StepNotFound"
)({
  _tag: Schema.tag("StepNotFound"),
  step: Schema.Number
}) {}

const api = { ChoiceNotFound, ChoiceUnavailable, StepNotFound }

/**
 * Starts at the document's captured snapshot when present, otherwise at its
 * statically declared initial configuration.
 *
 * @category constructors
 * @since 0.25.0
 */
export const start: (document: MachineDocument.MachineDocument) => Session = internal.start

/**
 * Returns the frame selected by the session cursor.
 *
 * @category getters
 * @since 0.25.0
 */
export const current: (self: Session) => Frame = internal.current

/**
 * Returns every retained frame, including frames after the current cursor.
 *
 * @category getters
 * @since 0.25.0
 */
export const timeline: (self: Session) => ReadonlyArray<Frame> = internal.timeline

/**
 * Returns the current zero-based timeline position.
 *
 * @category getters
 * @since 0.25.0
 */
export const cursor: (self: Session) => number = internal.cursor

/**
 * Lists documented branches whose sources are active at the current cursor.
 * Runtime-dependent choices remain visible with an unavailable reason.
 *
 * @category getters
 * @since 0.25.0
 */
export const choices: (self: Session) => ReadonlyArray<Choice> = internal.choices

/**
 * Takes one documented branch. Taking a branch from the past truncates the
 * future timeline before appending the new frame.
 *
 * @category combinators
 * @since 0.25.0
 */
export const take: {
  (choiceId: string): (self: Session) => Result.Result<Session, ChoiceNotFound | ChoiceUnavailable>
  (self: Session, choiceId: string): Result.Result<Session, ChoiceNotFound | ChoiceUnavailable>
} = dual(2, internal.take(api))

/**
 * Moves the cursor to an existing frame without changing the timeline.
 *
 * @category combinators
 * @since 0.25.0
 */
export const seek: {
  (step: number): (self: Session) => Result.Result<Session, StepNotFound>
  (self: Session, step: number): Result.Result<Session, StepNotFound>
} = dual(2, internal.seek(api))
