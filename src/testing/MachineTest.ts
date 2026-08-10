/**
 * Property-based scenario generation and planner trace utilities.
 *
 * @since 4.0.0
 */

import type * as Effect from "effect/Effect"
import type * as Graph from "effect/Graph"
import type * as Schema from "effect/Schema"
import type { FastCheck } from "effect/testing"
import type { EnsureExecutable } from "../internal/machine/readiness.js"
import type { SchemaArbitraryReport } from "../internal/testing/machine/arbitrary.js"
import type { FiniteModel } from "../internal/testing/machine/finiteModel.js"
import type * as ReferenceModel from "../internal/testing/machine/referenceModel.js"
import * as internal from "../internal/testing/machine/verification.js"
import type { VerificationError } from "../internal/testing/machine/verification.js"
import type * as Machine from "../Machine.js"

export {
  advanceCommand,
  type CausalRuntimeAssertionContext,
  type CausalRuntimeCommandActual,
  CausalRuntimeCommandFailure,
  type CausalRuntimeCommandRecord,
  type CausalRuntimeCommandResult,
  type CausalRuntimeInspectionContext,
  type CausalRuntimeModelOptions,
  type CausalRuntimeModelStep,
  type CausalRuntimeTranscript,
  type CausalVerificationAwaitContext,
  type CausalVerificationOptions,
  type CausalVerificationTranscript,
  checkpointCommand,
  type EnqueuedRuntimeAssertionContext,
  type EnqueuedRuntimeCommandActual,
  type EnqueuedRuntimeCommandRecord,
  type EnqueuedRuntimeInspectionContext,
  type EnqueuedRuntimeModelOptions,
  type EnqueuedRuntimeModelStep,
  type EnqueuedRuntimeTranscript,
  formatCausalTranscript,
  formatEnqueuedTranscript,
  formatRuntimeTranscript,
  runCausalCommands,
  runEnqueuedCommands,
  runRuntimeCommands,
  type RuntimeAssertionContext,
  type RuntimeAwait,
  type RuntimeCommand,
  type RuntimeCommandActual,
  RuntimeCommandFailure,
  type RuntimeCommandRecord,
  type RuntimeCommandResult,
  type RuntimeCommands,
  runtimeCommands,
  type RuntimeCommandsDiagnostics,
  type RuntimeCommandsOptions,
  type RuntimeInspectionContext,
  type RuntimeModelOptions,
  type RuntimeModelStep,
  RuntimeObservationError,
  RuntimeSynchronization,
  type RuntimeTranscript,
  sendCommand,
  stopCommand,
  verifyCausalCommands
} from "../internal/testing/machine/verification.js"

export type {
  SchemaArbitraryOpaqueFilterWarning,
  SchemaArbitraryReport,
  SchemaArbitraryWarning
} from "../internal/testing/machine/verification.js"

export {
  compileModel,
  type FiniteAtomicState,
  type FiniteAutomaticTransition,
  type FiniteCompoundState,
  type FiniteEventTransition,
  type FiniteFinalState,
  type FiniteHistoryMutation,
  type FiniteHistoryScenario,
  type FiniteHistoryState,
  type FiniteHistoryTransfer,
  type FiniteModel,
  type FiniteModelDiagnostics,
  type FiniteModelOptions,
  type FiniteModels,
  finiteModels,
  type FiniteParallelState,
  type FiniteState,
  type FiniteTransition,
  type FiniteTransitionTrigger
} from "../internal/testing/machine/verification.js"

export {
  ModelVerificationError,
  type ModelVerificationField,
  type ModelVerificationLocation,
  type ModelVerificationMismatch,
  type ReferenceCompletion,
  type ReferenceHistoryRecord,
  type ReferenceInitialStep,
  type ReferenceMicrostep,
  type ReferenceState,
  type ReferenceStateValue,
  type ReferenceStep,
  type ReferenceTrace,
  type ReferenceTransition
} from "../internal/testing/machine/verification.js"

/**
 * Purely interprets a finite hierarchical model without compiling a
 * machine.
 *
 * @category verification
 * @since 4.0.0
 */
export const interpretModel: (model: FiniteModel, events: ReadonlyArray<string>) => ReferenceModel.ReferenceTrace =
  internal.interpretModel

type AnyMachine = Machine.Machine.Any

type InputValue<M extends AnyMachine> = Machine.Machine.Input<M>["Type"]

type StatePath<M extends AnyMachine> = Machine.Machine.StateIdentifier<Machine.Machine.States<M>>

type StateNodePath<M extends AnyMachine> = Machine.Machine.StateNodeIdentifier<Machine.Machine.States<M>>

type IsAny<A> = 0 extends (1 & A) ? true : false

type ReadyMachine<M extends AnyMachine> =
  & M
  & EnsureExecutable<
    Machine.Machine.States<M>,
    Machine.Machine.UnhandledStates<M>,
    Machine.Machine.OutputStates<M>
  >

/**
 * A generated public-input scenario for a machine.
 *
 * Machines without an input schema omit `input`; machines with one retain its
 * exact decoded type. Events use only the public input protocol.
 *
 * @category models
 * @since 4.0.0
 */
export type Scenario<M extends AnyMachine> = Machine.Machine.Input<M> extends typeof Schema.Void ? {
    readonly events: ReadonlyArray<Machine.Machine.InputEvent<M>>
  }
  : {
    readonly input: InputValue<M>
    readonly events: ReadonlyArray<Machine.Machine.InputEvent<M>>
  }

/**
 * Options for schema-derived scenario generation.
 *
 * `inputArbitrary` and `eventsArbitrary` replace their complete generated
 * value. An events override therefore owns its own length distribution.
 *
 * @category models
 * @since 4.0.0
 */
export type ScenarioOptions<M extends AnyMachine> =
  & {
    readonly minEvents?: number
    readonly maxEvents?: number
    readonly eventsArbitrary?: FastCheck.Arbitrary<ReadonlyArray<Machine.Machine.InputEvent<M>>>
  }
  & (Machine.Machine.Input<M> extends typeof Schema.Void ? {
      readonly inputArbitrary?: never
    }
    : {
      readonly inputArbitrary?: FastCheck.Arbitrary<InputValue<M>>
    })

/**
 * Diagnostics for one schema-derived arbitrary.
 *
 * @category models
 * @since 4.0.0
 */
export interface SchemaArbitraryDiagnostic {
  readonly boundary: "input" | "event"
  readonly index: number | undefined
  readonly report: SchemaArbitraryReport
}

/**
 * Diagnostics describing how a scenario arbitrary was assembled.
 *
 * @category models
 * @since 4.0.0
 */
export interface ScenarioDiagnostics {
  readonly input: "none" | "schema" | "override"
  readonly events: "empty" | "schema" | "override"
  readonly schemas: ReadonlyArray<SchemaArbitraryDiagnostic>
}

/**
 * A scenario arbitrary together with schema-derivation diagnostics.
 *
 * @category models
 * @since 4.0.0
 */
export interface Scenarios<M extends AnyMachine> {
  readonly arbitrary: FastCheck.Arbitrary<Scenario<M>>
  readonly diagnostics: ScenarioDiagnostics
}

/**
 * Derives valid machine inputs and public events from their schemas.
 *
 * Unsupported schema derivations fail immediately through `Schema.toArbitrary`.
 * Non-fatal derivation warnings are returned instead of being hidden.
 *
 * @category constructors
 * @since 4.0.0
 */
export const scenarios: <M extends AnyMachine>(machine: M, options?: ScenarioOptions<M>) => Scenarios<M> =
  internal.scenarios

/**
 * Completion information retained by an initial or event plan.
 *
 * @category models
 * @since 4.0.0
 */
export type PlanCompletion<M extends AnyMachine> =
  | {
    readonly done: true
    readonly output: Machine.Machine.Output<M>
  }
  | {
    readonly done: false
    readonly output: undefined
  }

/**
 * One public planned microstep, including retained post-conflict transitions.
 *
 * @category models
 * @since 4.0.0
 */
export interface Microstep<
  M extends AnyMachine,
  Requirements = Machine.Machine.Services<M>
> {
  readonly next: Machine.Machine.Snapshot<Machine.Machine.States<M>>
  readonly event: Machine.Machine.Event<M> | Machine.InitialEvent
  readonly transitions: ReadonlyArray<
    Machine.Machine.RetainedTransition<
      StatePath<M>,
      Machine.Machine.TagOf<Machine.Machine.Events<M>[number]>,
      StateNodePath<M>
    >
  >
  readonly commands: ReadonlyArray<Machine.Command>
  readonly raisedEvents: ReadonlyArray<Machine.Machine.Event<M>>
  readonly emittedEvents: ReadonlyArray<Machine.Machine.Emit<M>>
  readonly exitPaths: ReadonlyArray<string>
  readonly entryPaths: ReadonlyArray<string>
  readonly changed: boolean
}

/**
 * The complete data returned while planning machine startup.
 *
 * @category models
 * @since 4.0.0
 */
export type InitialPlan<M extends AnyMachine> =
  & {
    readonly startingState: Machine.Machine.Snapshot<Machine.Machine.States<M>>
    readonly initialEntryPaths: ReadonlyArray<StatePath<M>>
    readonly state: Machine.Machine.Snapshot<Machine.Machine.States<M>>
    readonly commands: ReadonlyArray<Machine.Command>
    readonly emittedEvents: ReadonlyArray<Machine.Machine.Emit<M>>
    readonly microsteps: ReadonlyArray<
      Microstep<M, Machine.Machine.InitialServices<M> | Machine.Machine.Services<M>>
    >
  }
  & PlanCompletion<M>

/**
 * The complete data returned while planning one public event.
 *
 * @category models
 * @since 4.0.0
 */
export type EventPlan<M extends AnyMachine> =
  & {
    readonly next: Machine.Machine.Snapshot<Machine.Machine.States<M>>
    readonly commands: ReadonlyArray<Machine.Command>
    readonly emittedEvents: ReadonlyArray<Machine.Machine.Emit<M>>
    readonly microsteps: ReadonlyArray<Microstep<M>>
  }
  & PlanCompletion<M>

/**
 * Startup portion of an executable planner trace.
 *
 * @category models
 * @since 4.0.0
 */
export interface InitialTrace<M extends AnyMachine> {
  readonly plan: InitialPlan<M>
  readonly startingState: Machine.Machine.Snapshot<Machine.Machine.States<M>>
  readonly startingConfiguration: ReadonlyArray<StatePath<M>>
  readonly initialEntryPaths: ReadonlyArray<StatePath<M>>
  readonly configuration: ReadonlyArray<StatePath<M>>
}

/**
 * One event portion of an executable planner trace.
 *
 * @category models
 * @since 4.0.0
 */
export interface TraceStep<M extends AnyMachine> {
  readonly index: number
  readonly before: Machine.Machine.Snapshot<Machine.Machine.States<M>>
  readonly beforeConfiguration: ReadonlyArray<StatePath<M>>
  readonly event: Machine.Machine.InputEvent<M>
  readonly plan: EventPlan<M>
  readonly after: Machine.Machine.Snapshot<Machine.Machine.States<M>>
  readonly afterConfiguration: ReadonlyArray<StatePath<M>>
}

/**
 * A scenario and every plan produced by executing it without running actions.
 *
 * @category models
 * @since 4.0.0
 */
export interface Trace<M extends AnyMachine> {
  readonly scenario: Scenario<M>
  readonly initial: InitialTrace<M>
  readonly steps: ReadonlyArray<TraceStep<M>>
  readonly final: Machine.Machine.Snapshot<Machine.Machine.States<M>>
  readonly finalConfiguration: ReadonlyArray<StatePath<M>>
}

/**
 * One runtime microstep retained by the execution strategy used by a probe.
 *
 * Transition-definition metadata is intentionally not reconstructed here:
 * optimized runtimes retain execution evidence, while `run` and `plan` remain
 * the APIs for complete diagnostic transition metadata.
 *
 * @category runtime testing
 * @since 4.0.0
 */
export type ProbeMicrostep<M extends AnyMachine> = Omit<Microstep<M>, "transitions">

/**
 * Runtime plan evidence associated with one acknowledged public event.
 *
 * @category runtime testing
 * @since 4.0.0
 */
export type ProbePlan<M extends AnyMachine> =
  & {
    readonly next: Machine.Machine.Snapshot<Machine.Machine.States<M>>
    readonly commands: ReadonlyArray<Machine.Command>
    readonly emittedEvents: ReadonlyArray<Machine.Machine.Emit<M>>
    readonly microsteps: ReadonlyArray<ProbeMicrostep<M>>
  }
  & PlanCompletion<M>

/**
 * Causal evidence produced after one event has completed its managed runtime
 * macrostep.
 *
 * `handled` distinguishes an ignored event from a retained transition that
 * deliberately leaves the logical state unchanged. `configurationChanged`
 * reports whether any microstep changed or reentered the active statechart
 * configuration; compare `before` and `after` for state-value assertions.
 *
 * @category runtime testing
 * @since 4.0.0
 */
export interface ProbeStep<M extends AnyMachine> {
  readonly event: Machine.Machine.InputEvent<M>
  readonly before: Machine.Machine.Snapshot<Machine.Machine.States<M>>
  readonly plan: ProbePlan<M>
  readonly after: Machine.Machine.Snapshot<Machine.Machine.States<M>>
  readonly handled: boolean
  readonly configurationChanged: boolean
}

/**
 * Testing-only causal access to a managed statechart reference.
 *
 * A probe does not change ordinary machine scheduling. `sendAndAwait` uses an
 * acknowledged mailbox delivery so an ignored event can be proven processed
 * without waiting for a snapshot that will never be published.
 *
 * @category runtime testing
 * @since 4.0.0
 */
export interface Probe<M extends AnyMachine, Error = never, Output = never> {
  readonly machine: M
  readonly ref: Machine.MachineRef<
    Machine.Machine.Snapshot<Machine.Machine.States<M>>,
    Machine.Machine.InputEvent<M>,
    Error,
    Output
  >
  readonly sendAndAwait: (
    event: Machine.Machine.InputEvent<M>
  ) => Effect.Effect<ProbeStep<M>, Error | Machine.StoppedError>
  /** Constructors for asynchronous observation after a causal command. */
  readonly await: {
    readonly none: internal.RuntimeAwait<
      Machine.Machine.Snapshot<Machine.Machine.States<M>>,
      Error,
      Output
    >
    readonly until: (
      predicate: (
        snapshot: Machine.RuntimeSnapshot<
          Machine.Machine.Snapshot<Machine.Machine.States<M>>,
          Error,
          Output
        >
      ) => boolean
    ) => internal.RuntimeAwait<Machine.Machine.Snapshot<Machine.Machine.States<M>>, Error, Output>
  }
}

/**
 * Raised when `probe` receives a reference that is not backed by the managed
 * statechart runtime.
 *
 * @category errors
 * @since 4.0.0
 */
export { ProbeUnavailableError } from "../internal/testing/machine/verification.js"

/**
 * Attaches testing-only causal event delivery to a running statechart.
 *
 * The returned probe exposes `sendAndAwait`; ordinary production sends remain
 * available exclusively through `MachineRef.send` and retain their
 * asynchronous enqueue-only semantics.
 *
 * @category runtime testing
 * @since 4.0.0
 */
export const probe: <M extends AnyMachine, Error, Output>(
  machine: ReadyMachine<M>,
  ref: Machine.MachineRef<
    Machine.Machine.Snapshot<Machine.Machine.States<M>>,
    Machine.Machine.InputEvent<M>,
    Error,
    Output
  >
) => Effect.Effect<Probe<M, Error, Output>, internal.ProbeUnavailableError> = internal.probe

/** The runtime error channel exposed by a managed reference for a machine. */
export type RuntimeInvariantErrorChannel<M extends AnyMachine> =
  | Machine.Machine.Error<M>
  | Machine.ActionError<Machine.Machine.Services<M>>
  | Machine.InfiniteTransitionError
  | Machine.MachineSchemaDecodeError
  | Machine.StoppedError

/** A causal command record projected independently of a reference model. */
export interface CausalRuntimeEvidenceRecord<M extends AnyMachine, Error, Output> {
  readonly index: number
  readonly command: internal.RuntimeCommand<Machine.Machine.InputEvent<M>>
  readonly actual: internal.CausalRuntimeCommandActual<M, Error, Output, unknown>
}

/** The model-independent evidence shared by causal command transcripts. */
export interface CausalRuntimeEvidence<M extends AnyMachine, Error, Output> {
  readonly commands: ReadonlyArray<internal.RuntimeCommand<Machine.Machine.InputEvent<M>>>
  readonly initial: Machine.RuntimeSnapshot<Machine.Machine.Snapshot<Machine.Machine.States<M>>, Error, Output>
  readonly records: ReadonlyArray<CausalRuntimeEvidenceRecord<M, Error, Output>>
  readonly final: Machine.RuntimeSnapshot<Machine.Machine.Snapshot<Machine.Machine.States<M>>, Error, Output>
}

/** The runtime snapshots selected by one snapshot invariant. */
export type RuntimeSnapshotObservationMode = "settled" | "awaited" | "all" | "final"

/** The semantic location of one retained runtime snapshot. */
export type RuntimeSnapshotObservation = "initial" | "command" | "awaited" | "final"

/** A model-independent command record supplied to runtime laws. */
export interface RuntimeInvariantRecord<M extends AnyMachine> {
  readonly index: number
  readonly command: internal.RuntimeCommand<Machine.Machine.InputEvent<M>>
  readonly result: internal.CausalRuntimeCommandResult<M>
  readonly snapshot: Machine.RuntimeSnapshot<
    Machine.Machine.Snapshot<Machine.Machine.States<M>>,
    RuntimeInvariantErrorChannel<M>,
    Machine.Machine.Output<M>
  >
  readonly awaited: ReadonlyArray<
    Machine.RuntimeSnapshot<
      Machine.Machine.Snapshot<Machine.Machine.States<M>>,
      RuntimeInvariantErrorChannel<M>,
      Machine.Machine.Output<M>
    >
  >
}

/** A model-independent causal transcript supplied to runtime laws. */
export interface RuntimeInvariantTranscript<M extends AnyMachine> {
  readonly commands: ReadonlyArray<internal.RuntimeCommand<Machine.Machine.InputEvent<M>>>
  readonly initial: Machine.RuntimeSnapshot<
    Machine.Machine.Snapshot<Machine.Machine.States<M>>,
    RuntimeInvariantErrorChannel<M>,
    Machine.Machine.Output<M>
  >
  readonly records: ReadonlyArray<RuntimeInvariantRecord<M>>
  readonly final: Machine.RuntimeSnapshot<
    Machine.Machine.Snapshot<Machine.Machine.States<M>>,
    RuntimeInvariantErrorChannel<M>,
    Machine.Machine.Output<M>
  >
}

/** Evidence passed to a runtime snapshot invariant. */
export interface RuntimeSnapshotInvariantContext<M extends AnyMachine> {
  readonly machine: M
  readonly transcript: RuntimeInvariantTranscript<M>
  readonly snapshot: RuntimeInvariantTranscript<M>["initial"]
  readonly observationIndex: number
  readonly phase: RuntimeSnapshotObservation
  readonly commandIndex: number | undefined
  readonly awaitedIndex: number | undefined
  readonly command: internal.RuntimeCommand<Machine.Machine.InputEvent<M>> | undefined
  readonly result: internal.CausalRuntimeCommandResult<M> | undefined
}

/** Evidence passed to an invariant for one completed causal command. */
export interface RuntimeCommandInvariantContext<M extends AnyMachine> {
  readonly machine: M
  readonly transcript: RuntimeInvariantTranscript<M>
  readonly record: RuntimeInvariantRecord<M>
  readonly previous: RuntimeInvariantRecord<M> | undefined
  readonly index: number
  readonly command: internal.RuntimeCommand<Machine.Machine.InputEvent<M>>
  readonly result: internal.CausalRuntimeCommandResult<M>
  readonly snapshot: RuntimeInvariantRecord<M>["snapshot"]
  readonly awaited: RuntimeInvariantRecord<M>["awaited"]
}

/** Evidence passed to a whole-runtime-transcript invariant. */
export interface RuntimeTranscriptInvariantContext<M extends AnyMachine> {
  readonly machine: M
  readonly transcript: RuntimeInvariantTranscript<M>
}

/** Options for a runtime snapshot invariant. */
export interface RuntimeSnapshotInvariantOptions<M extends AnyMachine>
  extends InvariantOptions<RuntimeSnapshotInvariantContext<M>>
{
  readonly observe?: RuntimeSnapshotObservationMode
}

/** A semantic property checked against selected live runtime snapshots. */
export interface RuntimeSnapshotInvariant<M extends AnyMachine>
  extends InvariantOptions<RuntimeSnapshotInvariantContext<M>>
{
  readonly _tag: "RuntimeSnapshotInvariant"
  readonly name: string
  readonly observe: RuntimeSnapshotObservationMode
  readonly check: (context: RuntimeSnapshotInvariantContext<M>) => InvariantOutcome
}

/** A semantic property checked after every completed causal command. */
export interface RuntimeCommandInvariant<M extends AnyMachine>
  extends InvariantOptions<RuntimeCommandInvariantContext<M>>
{
  readonly _tag: "RuntimeCommandInvariant"
  readonly name: string
  readonly check: (context: RuntimeCommandInvariantContext<M>) => InvariantOutcome
}

/** A semantic property checked once against a complete causal transcript. */
export interface RuntimeTranscriptInvariant<M extends AnyMachine>
  extends InvariantOptions<RuntimeTranscriptInvariantContext<M>>
{
  readonly _tag: "RuntimeTranscriptInvariant"
  readonly name: string
  readonly check: (context: RuntimeTranscriptInvariantContext<M>) => InvariantOutcome
}

/** A user-defined semantic property over retained live runtime evidence. */
export type RuntimeInvariant<M extends AnyMachine> =
  | RuntimeSnapshotInvariant<M>
  | RuntimeCommandInvariant<M>
  | RuntimeTranscriptInvariant<M>

/** Machine-bound runtime invariant constructors with exact event inference. */
export interface RuntimeInvariantBuilder<M extends AnyMachine> {
  readonly snapshot: (
    name: string,
    check: (context: RuntimeSnapshotInvariantContext<M>) => InvariantOutcome,
    options?: RuntimeSnapshotInvariantOptions<M>
  ) => RuntimeSnapshotInvariant<M>
  readonly command: (
    name: string,
    check: (context: RuntimeCommandInvariantContext<M>) => InvariantOutcome,
    options?: InvariantOptions<RuntimeCommandInvariantContext<M>>
  ) => RuntimeCommandInvariant<M>
  readonly transcript: (
    name: string,
    check: (context: RuntimeTranscriptInvariantContext<M>) => InvariantOutcome,
    options?: InvariantOptions<RuntimeTranscriptInvariantContext<M>>
  ) => RuntimeTranscriptInvariant<M>
}

/** Creates reusable semantic laws for causal runtime evidence. */
export const runtimeInvariants: <M extends AnyMachine>(machine: M) => RuntimeInvariantBuilder<M> =
  internal.runtimeInvariants

/** Scope of a runtime invariant. */
export type RuntimeInvariantScope = "snapshot" | "command" | "transcript"

/** Aggregate result for one runtime invariant. */
export interface RuntimeInvariantCheckResult {
  readonly invariant: string
  readonly scope: RuntimeInvariantScope
  readonly status: InvariantStatus
  readonly observations: number
  readonly failures: number
}

/** Aggregate result for all checked runtime invariants. */
export interface RuntimeInvariantReport {
  readonly checks: ReadonlyArray<RuntimeInvariantCheckResult>
}

/** One runtime invariant violation and its exact retained location. */
export interface RuntimeInvariantViolation<M extends AnyMachine = AnyMachine> {
  readonly invariant: string
  readonly scope: RuntimeInvariantScope
  readonly kind: "predicate" | "observations"
  readonly observationIndex?: number
  readonly commandIndex: number | undefined
  readonly awaitedIndex?: number
  readonly phase?: RuntimeSnapshotObservation
  readonly command?: internal.RuntimeCommand<Machine.Machine.InputEvent<M>>
  readonly message: string
}

/** All violations found in one causal runtime transcript. */
export { RuntimeInvariantError } from "../internal/testing/machine/verification.js"

/** Checks runtime invariants and returns their complete non-vacuity report. */
export const checkRuntimeInvariants: <M extends AnyMachine, Error, Output>(
  machine: M,
  transcript: CausalRuntimeEvidence<M, Error, Output>,
  invariants: ReadonlyArray<RuntimeInvariant<M>>
) => Effect.Effect<RuntimeInvariantReport, internal.RuntimeInvariantError<M>> = internal.checkRuntimeInvariants

/** Asserts runtime invariants against an existing causal transcript. */
export const assertRuntimeInvariants: <M extends AnyMachine, Error, Output>(
  machine: M,
  transcript: CausalRuntimeEvidence<M, Error, Output>,
  invariants: ReadonlyArray<RuntimeInvariant<M>>
) => Effect.Effect<void, internal.RuntimeInvariantError<M>> = internal.assertRuntimeInvariants

/** One disagreement between pure planning and a causally processed send. */
export interface PlannerRuntimeAgreementViolation<M extends AnyMachine = AnyMachine> {
  readonly commandIndex: number
  readonly command: internal.RuntimeCommand<Machine.Machine.InputEvent<M>>
  readonly field:
    | "planning"
    | "handled"
    | "configurationChanged"
    | "planNext"
    | "after"
    | "completion"
    | "commands"
    | "emittedEvents"
    | "microsteps"
  readonly message: string
}

/** Raised when live causal evidence disagrees with a fresh pure plan. */
export { PlannerRuntimeAgreementError } from "../internal/testing/machine/verification.js"

/** Checks that every processed public send agrees with a fresh pure plan. */
export const assertPlannerRuntimeAgreement: <M extends AnyMachine, Error, Output>(
  machine: ReadyMachine<M>,
  transcript: CausalRuntimeEvidence<M, Error, Output>
) => Effect.Effect<void, internal.PlannerRuntimeAgreementError<M>, RunServices<M>> =
  internal.assertPlannerRuntimeAgreement

/**
 * The result of evaluating one semantic invariant.
 *
 * `true` passes, `false` produces a default failure message, and a string
 * fails with that string as its counterexample explanation.
 *
 * @category invariants
 * @since 4.0.0
 */
export type InvariantOutcome = boolean | string

/**
 * The portions of a trace that a state invariant may observe.
 *
 * - `settled` observes startup and the state after every public event.
 * - `microsteps` observes every internal microstep.
 * - `all` observes both settled states and microsteps.
 * - `final` observes only the final state.
 *
 * @category invariants
 * @since 4.0.0
 */
export type StateObservationMode = "settled" | "microsteps" | "all" | "final"

/**
 * The semantic location of one state observation.
 *
 * @category invariants
 * @since 4.0.0
 */
export type StateObservation = "initial" | "event" | "microstep" | "final"

/**
 * Evidence passed to a state invariant.
 *
 * @category invariants
 * @since 4.0.0
 */
export interface StateInvariantContext<M extends AnyMachine> {
  readonly machine: M
  readonly trace: Trace<M>
  readonly snapshot: Machine.Machine.Snapshot<Machine.Machine.States<M>>
  readonly configuration: ReadonlyArray<StatePath<M>>
  readonly observationIndex: number
  readonly phase: StateObservation
  readonly eventIndex: number | undefined
  readonly microstepIndex: number | undefined
  readonly event: Machine.Machine.Event<M> | Machine.InitialEvent | undefined
}

/**
 * Evidence passed to an invariant for one public event step.
 *
 * @category invariants
 * @since 4.0.0
 */
export interface StepInvariantContext<M extends AnyMachine> {
  readonly machine: M
  readonly trace: Trace<M>
  readonly step: TraceStep<M>
  readonly index: number
  readonly before: Machine.Machine.Snapshot<Machine.Machine.States<M>>
  readonly beforeConfiguration: ReadonlyArray<StatePath<M>>
  readonly event: Machine.Machine.InputEvent<M>
  readonly plan: EventPlan<M>
  readonly after: Machine.Machine.Snapshot<Machine.Machine.States<M>>
  readonly afterConfiguration: ReadonlyArray<StatePath<M>>
}

/**
 * Evidence passed to a whole-trace invariant.
 *
 * @category invariants
 * @since 4.0.0
 */
export interface TraceInvariantContext<M extends AnyMachine> {
  readonly machine: M
  readonly trace: Trace<M>
}

/**
 * Controls conditional invariant evaluation and optional non-vacuity checks.
 *
 * A condition that never matches is reported as `untested`. Set
 * `require.minObservations` when that must fail the check instead.
 *
 * @category invariants
 * @since 4.0.0
 */
export interface InvariantOptions<Context> {
  readonly when?: (context: Context) => boolean
  readonly require?: {
    readonly minObservations: number
  }
}

/**
 * Options for a state invariant.
 *
 * @category invariants
 * @since 4.0.0
 */
export interface StateInvariantOptions<M extends AnyMachine> extends InvariantOptions<StateInvariantContext<M>> {
  readonly observe?: StateObservationMode
}

/**
 * A semantic property checked against selected state observations.
 *
 * @category invariants
 * @since 4.0.0
 */
export interface StateInvariant<M extends AnyMachine> extends InvariantOptions<StateInvariantContext<M>> {
  readonly _tag: "StateInvariant"
  readonly name: string
  readonly observe: StateObservationMode
  readonly check: (context: StateInvariantContext<M>) => InvariantOutcome
}

/**
 * A semantic property checked after every public event.
 *
 * @category invariants
 * @since 4.0.0
 */
export interface StepInvariant<M extends AnyMachine> extends InvariantOptions<StepInvariantContext<M>> {
  readonly _tag: "StepInvariant"
  readonly name: string
  readonly check: (context: StepInvariantContext<M>) => InvariantOutcome
}

/**
 * A semantic property checked once against a complete trace.
 *
 * @category invariants
 * @since 4.0.0
 */
export interface TraceInvariant<M extends AnyMachine> extends InvariantOptions<TraceInvariantContext<M>> {
  readonly _tag: "TraceInvariant"
  readonly name: string
  readonly check: (context: TraceInvariantContext<M>) => InvariantOutcome
}

/**
 * A user-defined semantic property over a planner trace.
 *
 * @category invariants
 * @since 4.0.0
 */
export type Invariant<M extends AnyMachine> = StateInvariant<M> | StepInvariant<M> | TraceInvariant<M>

/**
 * Machine-bound invariant constructors with complete contextual inference.
 *
 * @category invariants
 * @since 4.0.0
 */
export interface InvariantBuilder<M extends AnyMachine> {
  readonly state: (
    name: string,
    check: (context: StateInvariantContext<M>) => InvariantOutcome,
    options?: StateInvariantOptions<M>
  ) => StateInvariant<M>
  readonly step: (
    name: string,
    check: (context: StepInvariantContext<M>) => InvariantOutcome,
    options?: InvariantOptions<StepInvariantContext<M>>
  ) => StepInvariant<M>
  readonly trace: (
    name: string,
    check: (context: TraceInvariantContext<M>) => InvariantOutcome,
    options?: InvariantOptions<TraceInvariantContext<M>>
  ) => TraceInvariant<M>
}

/**
 * Direct invariant constructors. Prefer `invariants(machine)` when contextual
 * machine types should be inferred without an explicit type argument.
 *
 * @category constructors
 * @since 4.0.0
 */
export const Invariant: {
  readonly state: <M extends AnyMachine>(
    name: string,
    check: (context: StateInvariantContext<M>) => InvariantOutcome,
    options?: StateInvariantOptions<M>
  ) => StateInvariant<M>
  readonly step: <M extends AnyMachine>(
    name: string,
    check: (context: StepInvariantContext<M>) => InvariantOutcome,
    options?: InvariantOptions<StepInvariantContext<M>>
  ) => StepInvariant<M>
  readonly trace: <M extends AnyMachine>(
    name: string,
    check: (context: TraceInvariantContext<M>) => InvariantOutcome,
    options?: InvariantOptions<TraceInvariantContext<M>>
  ) => TraceInvariant<M>
} = internal.Invariant

/**
 * Creates invariant constructors bound to a machine's exact state and event
 * types. The machine is used only for inference; invariant evaluation remains
 * pure and reusable across traces from that machine.
 *
 * @category constructors
 * @since 4.0.0
 */
export const invariants: <M extends AnyMachine>(machine: M) => InvariantBuilder<M> = internal.invariants

/**
 * The scope of a semantic invariant.
 *
 * @category invariants
 * @since 4.0.0
 */
export type InvariantScope = "state" | "step" | "trace"

/**
 * Result status for one invariant.
 *
 * `untested` is non-failing unless the invariant declares a minimum number of
 * observations, in which case it becomes `insufficient`.
 *
 * @category invariants
 * @since 4.0.0
 */
export type InvariantStatus = "passed" | "failed" | "untested" | "insufficient"

/**
 * Aggregate result for one invariant.
 *
 * @category invariants
 * @since 4.0.0
 */
export interface InvariantCheckResult {
  readonly invariant: string
  readonly scope: InvariantScope
  readonly status: InvariantStatus
  readonly observations: number
  readonly failures: number
}

/**
 * Aggregate result for all checked invariants.
 *
 * @category invariants
 * @since 4.0.0
 */
export interface InvariantReport {
  readonly checks: ReadonlyArray<InvariantCheckResult>
}

/**
 * One semantic invariant violation with its precise trace location.
 *
 * @category invariants
 * @since 4.0.0
 */
export interface InvariantViolation<M extends AnyMachine = AnyMachine> {
  readonly invariant: string
  readonly scope: InvariantScope
  readonly kind: "predicate" | "observations"
  readonly observationIndex?: number
  readonly eventIndex: number | undefined
  readonly microstepIndex?: number
  readonly phase?: StateObservation
  readonly configuration?: ReadonlyArray<StatePath<M>>
  readonly event?: Machine.Machine.Event<M> | Machine.InitialEvent
  readonly message: string
}

/**
 * All semantic violations found in one trace, together with the complete
 * counterexample and aggregate report.
 *
 * @category errors
 * @since 4.0.0
 */
export { InvariantError } from "../internal/testing/machine/verification.js"

/**
 * Checks user-defined semantic invariants against an existing planner trace.
 *
 * Every invariant and matching observation is evaluated so one failure
 * contains all relevant evidence. Combine this with `scenarios` and `run` in
 * an Effect property test to retain FastCheck shrinking.
 *
 * @category verification
 * @since 4.0.0
 */
export const checkInvariants: <M extends AnyMachine>(
  machine: M,
  trace: Trace<M>,
  invariants: ReadonlyArray<Invariant<M>>
) => Effect.Effect<InvariantReport, internal.InvariantError<M>> = internal.checkInvariants

/**
 * Asserts user-defined semantic invariants and discards the success report.
 *
 * This is the property-test-oriented form of `checkInvariants`: its `void`
 * success works directly with `it.effect.prop`, while failures retain the
 * same complete report and trace evidence.
 *
 * @category verification
 * @since 4.0.0
 */
export const assertInvariants: <M extends AnyMachine>(
  machine: M,
  trace: Trace<M>,
  invariants: ReadonlyArray<Invariant<M>>
) => Effect.Effect<void, internal.InvariantError<M>> = internal.assertInvariants

/**
 * User-defined identity for a logical exploration state.
 *
 * Equal keys deliberately collapse snapshots into one explored state. The key
 * therefore defines both finiteness and the semantic precision of an
 * exploration.
 *
 * @category exploration
 * @since 4.0.0
 */
export type ExplorationKey = PropertyKey

/**
 * Hard bounds for one exploration.
 *
 * Defaults are 20 public events, 1,000 states, and 10,000 planned
 * transitions. A limit never makes an incomplete result appear exhaustive.
 *
 * @category exploration
 * @since 4.0.0
 */
export interface ExplorationLimits {
  readonly maxDepth?: number
  readonly maxStates?: number
  readonly maxTransitions?: number
}

/**
 * Resolved bounds retained by an exploration result.
 *
 * @category exploration
 * @since 4.0.0
 */
export interface ResolvedExplorationLimits {
  readonly maxDepth: number
  readonly maxStates: number
  readonly maxTransitions: number
}

/**
 * Evidence available while assigning a state key.
 *
 * @category exploration
 * @since 4.0.0
 */
export interface ExplorationStateContext<M extends AnyMachine> {
  readonly machine: M
  readonly snapshot: Machine.Machine.Snapshot<Machine.Machine.States<M>>
  readonly configuration: ReadonlyArray<StatePath<M>>
  readonly depth: number
  readonly trace: Trace<M>
}

/**
 * One logical state discovered by breadth-first exploration.
 *
 * `trace` is the first, and therefore shortest, trace that reached `key`.
 *
 * @category exploration
 * @since 4.0.0
 */
export interface ExplorationNode<M extends AnyMachine, Key extends ExplorationKey = ExplorationKey>
  extends ExplorationStateContext<M>
{
  readonly key: Key
}

/**
 * One concretely planned public event in the exploration graph.
 *
 * @category exploration
 * @since 4.0.0
 */
export interface ExplorationEdge<M extends AnyMachine> {
  readonly event: Machine.Machine.InputEvent<M>
  readonly step: TraceStep<M>
  readonly discovered: boolean
}

/**
 * One boundary that could not be explored because a hard limit was reached.
 *
 * @category exploration
 * @since 4.0.0
 */
export type ExplorationFrontier<M extends AnyMachine, Key extends ExplorationKey = ExplorationKey> =
  | {
    readonly _tag: "DepthLimit"
    readonly source: Key
    readonly trace: Trace<M>
    readonly event: Machine.Machine.InputEvent<M>
  }
  | {
    readonly _tag: "StateLimit"
    readonly source: Key
    readonly trace: Trace<M>
    readonly event: Machine.Machine.InputEvent<M>
    readonly target: Key
    readonly targetTrace: Trace<M>
  }
  | {
    readonly _tag: "TransitionLimit"
    readonly source: Key
    readonly trace: Trace<M>
    readonly event: Machine.Machine.InputEvent<M>
  }

/**
 * Honest completeness status for the supplied event representatives and state
 * key abstraction.
 *
 * @category exploration
 * @since 4.0.0
 */
export type ExplorationCompleteness<M extends AnyMachine, Key extends ExplorationKey = ExplorationKey> =
  | {
    readonly _tag: "Complete"
  }
  | {
    readonly _tag: "Truncated"
    readonly reasons: ReadonlyArray<"depth" | "states" | "transitions">
    readonly frontier: ReadonlyArray<ExplorationFrontier<M, Key>>
  }

/**
 * Deterministic breadth-first exploration counts.
 *
 * @category exploration
 * @since 4.0.0
 */
export interface ExplorationStats {
  readonly states: number
  readonly plannedTransitions: number
  readonly retainedEdges: number
  readonly maxDepth: number
}

/**
 * A bounded logical state graph and its shortest-path evidence.
 *
 * @category exploration
 * @since 4.0.0
 */
export interface Exploration<M extends AnyMachine, Key extends ExplorationKey = ExplorationKey> {
  readonly graph: Graph.DirectedGraph<ExplorationNode<M, Key>, ExplorationEdge<M>>
  readonly nodes: ReadonlyArray<ExplorationNode<M, Key>>
  readonly nodesByKey: ReadonlyMap<Key, Graph.NodeIndex>
  readonly start: Graph.NodeIndex
  readonly limits: ResolvedExplorationLimits
  readonly stats: ExplorationStats
  readonly completeness: ExplorationCompleteness<M, Key>
}

interface ExploreOptionsBase<M extends AnyMachine, Key extends ExplorationKey> {
  readonly events: (context: ExplorationStateContext<M>) => ReadonlyArray<Machine.Machine.InputEvent<M>>
  readonly stateKey: (context: ExplorationStateContext<M>) => Key
  readonly limits?: ExplorationLimits
  readonly invariants?: ReadonlyArray<Invariant<M>>
}

/**
 * Configuration for bounded planner exploration.
 *
 * Event representatives may depend on the current state. Exploration is
 * exhaustive only relative to those representatives and the equivalence
 * relation defined by `stateKey`.
 *
 * @category exploration
 * @since 4.0.0
 */
export type ExploreOptions<M extends AnyMachine, Key extends ExplorationKey = ExplorationKey> =
  & ExploreOptionsBase<M, Key>
  & (Machine.Machine.Input<M> extends typeof Schema.Void ? {
      readonly input?: never
    }
    : {
      readonly input: InputValue<M>
    })

/**
 * Explores the bounded logical state graph in breadth-first order.
 *
 * Invariants are checked against startup and every concretely planned edge,
 * so a failure retains a shortest discovered counterexample. Staged actions
 * and runtime activities are not executed.
 *
 * @category exploration
 * @since 4.0.0
 */
export const explore: <M extends AnyMachine, Key extends ExplorationKey>(
  machine: ReadyMachine<M>,
  options: ExploreOptions<M, Key>
) => Effect.Effect<
  Exploration<M, Key>,
  RunFailure<RunError<M>, M> | internal.InvariantError<M>,
  RunServices<M>
> = internal.explore

/**
 * A predicate over one explored logical state.
 *
 * @category exploration
 * @since 4.0.0
 */
export type ExplorationPredicate<M extends AnyMachine, Key extends ExplorationKey = ExplorationKey> = (
  node: ExplorationNode<M, Key>
) => boolean

/**
 * Why a reachability assertion failed.
 *
 * @category exploration
 * @since 4.0.0
 */
export type ReachabilityFailure = "NotFound" | "UnexpectedMatch" | "Inconclusive"

/**
 * A failed or inconclusive reachability assertion.
 *
 * @category errors
 * @since 4.0.0
 */
export { ReachabilityError } from "../internal/testing/machine/verification.js"

/**
 * Finds the first, and therefore shortest, explored state matching a
 * predicate.
 *
 * @category exploration
 * @since 4.0.0
 */
export const findShortest: <M extends AnyMachine, Key extends ExplorationKey>(
  exploration: Exploration<M, Key>,
  predicate: ExplorationPredicate<M, Key>
) => ExplorationNode<M, Key> | undefined = internal.findShortest

/**
 * Requires a matching state and returns its shortest witness.
 *
 * A truncated exploration without a witness fails as inconclusive rather than
 * claiming the state is unreachable.
 *
 * @category exploration
 * @since 4.0.0
 */
export const assertReachable: <M extends AnyMachine, Key extends ExplorationKey>(
  exploration: Exploration<M, Key>,
  name: string,
  predicate: ExplorationPredicate<M, Key>
) => Effect.Effect<ExplorationNode<M, Key>, internal.ReachabilityError<M, Key>> = internal.assertReachable

/**
 * Requires that no explored state matches a predicate.
 *
 * This assertion succeeds only for a complete exploration. A truncated
 * result without a witness fails as inconclusive.
 *
 * @category exploration
 * @since 4.0.0
 */
export const assertUnreachable: <M extends AnyMachine, Key extends ExplorationKey>(
  exploration: Exploration<M, Key>,
  name: string,
  predicate: ExplorationPredicate<M, Key>
) => Effect.Effect<void, internal.ReachabilityError<M, Key>> = internal.assertUnreachable

/**
 * Checks a real planner trace against the independent finite statechart model
 * interpreter.
 *
 * The oracle does not import the machine compiler, planner, snapshot helpers,
 * or target builders. It compares semantic projections of the public trace
 * and accumulates every disagreement in one structured error.
 *
 * @category verification
 * @since 4.0.0
 */
export const verifyModel: <M extends AnyMachine>(
  model: FiniteModel,
  actualTrace: Trace<M>
) => Effect.Effect<void, ReferenceModel.ModelVerificationError> = internal.verifyModel

/**
 * A typed planning failure together with every successfully completed trace
 * segment preceding it.
 *
 * @category models
 * @since 4.0.0
 */
export type RunFailure<Cause, M extends AnyMachine = AnyMachine> =
  | {
    readonly _tag: "MachineTestRunFailure"
    readonly scenario: Scenario<M>
    readonly phase: "initial"
    readonly eventIndex: undefined
    readonly event: undefined
    readonly initial: undefined
    readonly steps: readonly []
    readonly cause: Cause
  }
  | {
    readonly _tag: "MachineTestRunFailure"
    readonly scenario: Scenario<M>
    readonly phase: "event"
    readonly eventIndex: number
    readonly event: Machine.Machine.InputEvent<M>
    readonly initial: InitialTrace<M>
    readonly steps: ReadonlyArray<TraceStep<M>>
    readonly cause: Cause
  }

/**
 * Errors that can be produced while planning a complete scenario.
 *
 * @category errors
 * @since 4.0.0
 */
export type RunError<M extends AnyMachine> =
  | Machine.Machine.InitialError<M>
  | Machine.Machine.Error<M>
  | Machine.InfiniteTransitionError
  | Machine.MachineSchemaDecodeError
  | Machine.StartupError

/**
 * Services required while planning a complete scenario.
 *
 * Scenario execution delegates exclusively to the service-free `planInitial`
 * and `plan` APIs. Invoke services and managed runtime capabilities belong to
 * later execution, not synchronous planning.
 *
 * @category models
 * @since 4.0.0
 */
export type RunServices<M extends AnyMachine> = IsAny<
  Machine.PlanningServices<Machine.Machine.InitialServices<M> | Machine.Machine.Services<M>>
> extends true ? Machine.PlanningServices<Machine.Machine.InitialServices<M> | Machine.Machine.Services<M>> : never

/**
 * Executes a generated scenario exclusively through `planInitial` and `plan`.
 *
 * Staged actions are retained in each plan but are never executed. Every event
 * is planned, including events that occur after a terminal configuration.
 * Typed planning errors retain the scenario and successfully completed prefix
 * in a `RunFailure`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const run: <M extends AnyMachine>(
  machine: ReadyMachine<M>,
  scenario: Scenario<M>
) => Effect.Effect<Trace<M>, RunFailure<RunError<M>, M>, RunServices<M>> = internal.run

/**
 * A deterministic hit/miss summary for a finite set declared by a machine.
 *
 * @category models
 * @since 4.0.0
 */
export interface CoverageSummary<Item> {
  readonly total: number
  readonly hit: number
  readonly missing: number
  readonly hits: ReadonlyArray<Item>
  readonly misses: ReadonlyArray<Item>
}

/**
 * One active (non-history) state node in a state coverage summary.
 *
 * @category models
 * @since 4.0.0
 */
export interface StateCoverageItem<Path extends string = string> {
  readonly path: Path
  readonly type: Exclude<Machine.Machine.StateNode["type"], "history">
}

/**
 * State activation and lifecycle coverage.
 *
 * @category models
 * @since 4.0.0
 */
export interface StateCoverage<Path extends string = string> {
  readonly activation: CoverageSummary<StateCoverageItem<Path>>
  readonly entry: CoverageSummary<StateCoverageItem<Path>>
  readonly exit: CoverageSummary<StateCoverageItem<Path>>
}

/**
 * One stable transition-definition identity in definition order.
 *
 * @category models
 * @since 4.0.0
 */
export interface TransitionCoverageItem<
  SourcePath extends string = string,
  EventTag extends PropertyKey = PropertyKey,
  TargetPath extends string = SourcePath
> {
  readonly id: string
  readonly index: number
  readonly source: SourcePath
  readonly trigger: Machine.Machine.TransitionTrigger<EventTag>
  readonly reenter: boolean
  readonly targets: Machine.Machine.TransitionTargets<TargetPath>
}

/**
 * One public event tag declared by the machine.
 *
 * @category models
 * @since 4.0.0
 */
export interface EventCoverageItem<Tag extends PropertyKey = PropertyKey> {
  readonly tag: Tag
  readonly count: number
}

/**
 * Public event coverage, including events that no transition retained.
 *
 * @category models
 * @since 4.0.0
 */
export type EventCoverage<Tag extends PropertyKey = PropertyKey> =
  | {
    readonly available: true
    readonly total: number
    readonly hit: number
    readonly missing: number
    readonly hits: ReadonlyArray<EventCoverageItem<Tag>>
    readonly misses: ReadonlyArray<EventCoverageItem<Tag>>
    readonly observed: ReadonlyArray<EventCoverageItem<Tag>>
    readonly diagnostics: readonly []
  }
  | {
    readonly available: false
    readonly total: undefined
    readonly hit: undefined
    readonly missing: undefined
    readonly hits: undefined
    readonly misses: undefined
    readonly observed: ReadonlyArray<EventCoverageItem<Tag>>
    readonly diagnostics: ReadonlyArray<{
      readonly schemaIndex: number
      readonly message: string
    }>
  }

/**
 * Trace-derived scenario counts. There is no finite declared scenario space.
 *
 * @category models
 * @since 4.0.0
 */
export interface ScenarioCoverage {
  readonly traces: number
  readonly events: number
  readonly empty: number
}

/**
 * Trace-derived logical configuration counts. There is no claimed exhaustive total.
 *
 * @category models
 * @since 4.0.0
 */
export interface LogicalConfigurationCoverage {
  readonly observations: number
  readonly hit: number
  readonly identities: ReadonlyArray<string>
}

/**
 * Directly observed startup and microstep evidence.
 *
 * @category models
 * @since 4.0.0
 */
export interface MicrostepCoverageEvidence {
  readonly total: number
  readonly changed: number
  readonly targetless: number
  readonly raised: number
  readonly emitted: number
  readonly eventTriggered: number
  readonly alwaysTriggered: number
  readonly doneTriggered: number
  readonly choiceTriggered: number
}

/**
 * Directly observed completion evidence.
 *
 * @category models
 * @since 4.0.0
 */
export interface CompletionCoverageEvidence<Path extends string = string> {
  readonly donePlans: number
  readonly recordObservations: number
  readonly paths: ReadonlyArray<Path>
}

/**
 * Directly observed history records and history-target transitions.
 *
 * @category models
 * @since 4.0.0
 */
export interface HistoryCoverageEvidence<Path extends string = string> {
  readonly recordObservations: number
  readonly recorded: ReadonlyArray<{
    readonly path: Path
    readonly modes: ReadonlyArray<"shallow" | "deep">
  }>
  readonly targets: number
  readonly resolvedTargets: number
}

/**
 * Coverage computed only from observable machine definitions and planner traces.
 *
 * @category models
 * @since 4.0.0
 */
export interface Coverage<M extends AnyMachine> {
  readonly states: StateCoverage<StatePath<M>>
  readonly transitions: CoverageSummary<
    TransitionCoverageItem<
      StateNodePath<M>,
      Machine.Machine.TagOf<Machine.Machine.Events<M>[number]>,
      StateNodePath<M>
    >
  >
  readonly events: EventCoverage<Machine.Machine.TagOf<Machine.Machine.InputEvents<M>[number]>>
  readonly scenarios: ScenarioCoverage
  readonly logicalConfigurations: LogicalConfigurationCoverage
  readonly startup: {
    readonly traces: number
    readonly withMicrosteps: number
  }
  readonly microsteps: MicrostepCoverageEvidence
  readonly completion: CompletionCoverageEvidence<StatePath<M>>
  readonly history: HistoryCoverageEvidence<StateNodePath<M>>
}

/**
 * Computes deterministic, definition-aware coverage from completed planner
 * traces. Finite declared sets report hits and misses; scenarios and logical
 * configurations report observations only because their complete spaces are
 * generally infinite.
 *
 * @category verification
 * @since 4.0.0
 */
export const coverage: <M extends AnyMachine>(
  machine: M,
  traceOrTraces: Trace<M> | ReadonlyArray<Trace<M>>
) => Coverage<M> = internal.coverage

/**
 * The observation roles summarized for one logical graph node.
 *
 * @category models
 * @since 4.0.0
 */
export interface ObservedGraphNodeObservations {
  readonly total: number
  readonly startup: number
  readonly event: number
  readonly microstep: number
}

/**
 * One full encoded logical snapshot stored in the observed Effect graph.
 *
 * @category models
 * @since 4.0.0
 */
export interface ObservedGraphNode<M extends AnyMachine> {
  readonly id: string
  readonly snapshot: Machine.Machine.Snapshot<Machine.Machine.States<M>>
  readonly encoded: Machine.Machine.EncodedSnapshot
  readonly configuration: ReadonlyArray<StatePath<M>>
  readonly observations: ObservedGraphNodeObservations
}

/**
 * Retained evidence for one microstep inside an observed graph edge.
 *
 * @category models
 * @since 4.0.0
 */
export interface ObservedGraphMicrostep<M extends AnyMachine> {
  readonly next: string
  readonly event: Machine.Machine.Event<M> | Machine.InitialEvent
  readonly transitions: Microstep<M, any>["transitions"]
  readonly raisedEvents: ReadonlyArray<Machine.Machine.Event<M>>
  readonly emittedEvents: ReadonlyArray<Machine.Machine.Emit<M>>
  readonly exitPaths: ReadonlyArray<StatePath<M>>
  readonly entryPaths: ReadonlyArray<StatePath<M>>
  readonly changed: boolean
}

/**
 * A startup or public-event macrostep retained by the observed graph.
 *
 * @category models
 * @since 4.0.0
 */
export type ObservedGraphEdge<M extends AnyMachine> =
  | {
    readonly _tag: "Startup"
    readonly traceIndex: number
    readonly microsteps: ReadonlyArray<ObservedGraphMicrostep<M>>
    readonly completion: PlanCompletion<M>
  }
  | {
    readonly _tag: "Event"
    readonly traceIndex: number
    readonly eventIndex: number
    readonly event: Machine.Machine.InputEvent<M>
    readonly microsteps: ReadonlyArray<ObservedGraphMicrostep<M>>
    readonly completion: PlanCompletion<M>
  }

/**
 * An Effect directed graph plus stable indexes useful to graph algorithms.
 *
 * @category models
 * @since 4.0.0
 */
export interface ObservedGraph<M extends AnyMachine> {
  readonly graph: Graph.DirectedGraph<ObservedGraphNode<M>, ObservedGraphEdge<M>>
  readonly nodesById: ReadonlyMap<string, Graph.NodeIndex>
  /** Settled post-startup nodes from which public event paths begin. */
  readonly starts: ReadonlyArray<Graph.NodeIndex>
  /** Pre-settled startup sources connected to `starts` by `Startup` edges. */
  readonly startupSources: ReadonlyArray<Graph.NodeIndex>
}

/**
 * Converts concrete planner traces into an observed logical-state graph.
 * Nodes are deduplicated by the public snapshot encoding and every edge is a
 * concrete startup or public-event macrostep. This intentionally does not
 * claim to be a static or exhaustive graph of the machine.
 *
 * @category verification
 * @since 4.0.0
 */
export const observedGraph: <M extends AnyMachine>(
  machine: M,
  traceOrTraces: Trace<M> | ReadonlyArray<Trace<M>>
) => Effect.Effect<
  ObservedGraph<M>,
  Machine.MachineSchemaEncodeError,
  Machine.Machine.SnapshotEncodingServices<Machine.Machine.States<M>>
> = internal.observedGraph

/**
 * Independently checked families of planner laws.
 *
 * @category models
 * @since 4.0.0
 */
export type VerificationLawGroup =
  | "configuration"
  | "microsteps"
  | "completion"
  | "history"
  | "targetBounds"

/**
 * Stable identifiers for individual planner laws.
 *
 * @category models
 * @since 4.0.0
 */
export type VerificationLaw =
  | "configuration.shape"
  | "configuration.path"
  | "configuration.schema"
  | "configuration.hierarchy"
  | "configuration.compound"
  | "configuration.parallel"
  | "configuration.duplicate"
  | "configuration.trace"
  | "microsteps.unique"
  | "microsteps.order"
  | "microsteps.activeBefore"
  | "microsteps.activeAfter"
  | "microsteps.changed"
  | "microsteps.continuity"
  | "microsteps.reentry"
  | "completion.record"
  | "completion.output"
  | "completion.done"
  | "history.record"
  | "history.mode"
  | "history.path"
  | "history.value"
  | "history.shallow"
  | "history.deep"
  | "targetBounds.definition"
  | "targetBounds.target"

/**
 * One independently observed violation in a planner trace.
 *
 * @category models
 * @since 4.0.0
 */
export interface VerificationViolation {
  readonly law: VerificationLaw
  /** `undefined` identifies startup; otherwise this is the scenario event index. */
  readonly eventIndex: number | undefined
  readonly microstepIndex?: number
  readonly path?: string
  readonly message: string
}

/**
 * All violations found while checking one trace.
 *
 * @category errors
 * @since 4.0.0
 */
export { VerificationError } from "../internal/testing/machine/verification.js"

/**
 * Selects law families for the single canonical verifier. All run by default.
 *
 * @category models
 * @since 4.0.0
 */
export interface VerifyOptions {
  readonly laws?: ReadonlyArray<VerificationLawGroup>
}

/**
 * Verifies an executed trace using only public machine inspection and raw
 * snapshot data. The verifier deliberately does not reuse planner
 * normalization, encoding, finality, or other internal helpers.
 *
 * Every selected law is evaluated and returned in one structured error so a
 * shrunk property-test counterexample retains all relevant evidence.
 *
 * @category verification
 * @since 4.0.0
 */
export const verify: <M extends AnyMachine>(
  machine: M,
  trace: Trace<M>,
  options?: VerifyOptions
) => Effect.Effect<void, VerificationError> = internal.verify

/**
 * Formats a trace as deterministic, line-oriented counterexample evidence.
 *
 * Object keys and map/set entries are canonicalized. Deferred effects are
 * represented by counts so formatting never evaluates or inspects actions.
 * Failures include their original cause and every available successful prefix.
 *
 * @category formatting
 * @since 4.0.0
 */
export const formatTrace: <M extends AnyMachine, Cause>(trace: Trace<M> | RunFailure<Cause, M>) => string =
  internal.formatTrace
