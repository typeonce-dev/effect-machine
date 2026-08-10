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
  checkpointCommand,
  formatRuntimeTranscript,
  runRuntimeCommands,
  type RuntimeAssertionContext,
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
  stopCommand
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

type ExcludeCompatibleRuntime<Requirements, Events, Emits> = Requirements extends Machine.Runtime.Requirement<
  infer RequiredEvents,
  infer RequiredEmits
> ? IsAny<Requirements> extends true ? Requirements
  : [RequiredEvents] extends [Events] ? [RequiredEmits] extends [Emits] ? never : Requirements
  : Requirements
  : Requirements

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
 * @category models
 * @since 4.0.0
 */
export type RunServices<M extends AnyMachine> = ExcludeCompatibleRuntime<
  Machine.PlanningServices<Machine.Machine.InitialServices<M> | Machine.Machine.Services<M>>,
  Machine.Machine.Event<M>,
  Machine.Machine.Emit<M>
>

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
