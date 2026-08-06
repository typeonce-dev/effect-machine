/**
 * Property-based scenario generation and planner trace utilities.
 *
 * @since 4.0.0
 */

import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Graph from "effect/Graph"
import * as Schema from "effect/Schema"
import * as SchemaAST from "effect/SchemaAST"
import { FastCheck } from "effect/testing"
import type { FiniteModel } from "./internal/machineTestFiniteModel.js"
import * as ReferenceModel from "./internal/machineTestReferenceModel.js"
import * as Machine from "./Machine.js"

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
} from "./internal/machineTestRuntime.js"

export {
  compileModel,
  type FiniteAtomicState,
  type FiniteCompoundState,
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
  type FiniteTransition
} from "./internal/machineTestFiniteModel.js"

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
} from "./internal/machineTestReferenceModel.js"

/**
 * Purely interprets a finite hierarchical model without compiling a
 * machine.
 *
 * @category verification
 * @since 4.0.0
 */
export const interpretModel = ReferenceModel.interpretModel

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
  & Machine.Machine.EnsureOutputImplementations<
    Machine.Machine.States<M>,
    Machine.Machine.OutputStates<M>
  >
  & Machine.Machine.EnsureHistoryImplementations<
    Machine.Machine.States<M>,
    Machine.Machine.UnhandledStates<M>
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
  readonly report: Schema.Annotations.ToArbitrary.Report
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

const validateLength = (name: "minEvents" | "maxEvents", value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`MachineTest.scenarios expected ${name} to be a non-negative safe integer`)
  }
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
export const scenarios = <M extends AnyMachine>(
  machine: M,
  options: ScenarioOptions<M> = {} as ScenarioOptions<M>
): Scenarios<M> => {
  const minEvents = options.minEvents ?? 0
  const maxEvents = options.maxEvents ?? 50
  if (options.eventsArbitrary === undefined) {
    validateLength("minEvents", minEvents)
    validateLength("maxEvents", maxEvents)
    if (minEvents > maxEvents) {
      throw new Error("MachineTest.scenarios expected minEvents to be less than or equal to maxEvents")
    }
    if (machine.events.length === 0 && minEvents > 0) {
      throw new Error(
        "MachineTest.scenarios cannot generate a non-empty event sequence for a machine without public events"
      )
    }
  }

  const diagnostics: Array<SchemaArbitraryDiagnostic> = []
  const eventArbitraries = options.eventsArbitrary === undefined
    ? machine.events.map((schema, index) => {
      const derived = Schema.toArbitrary(schema, { report: true })
      diagnostics.push({
        boundary: "event",
        index,
        report: derived.report
      })
      return derived.value as FastCheck.Arbitrary<Machine.Machine.InputEvent<M>>
    })
    : []

  const eventsArbitrary = options.eventsArbitrary ?? (eventArbitraries.length === 0
    ? FastCheck.constant<ReadonlyArray<Machine.Machine.InputEvent<M>>>([])
    : FastCheck.array(
      FastCheck.oneof(
        ...eventArbitraries as [
          FastCheck.Arbitrary<Machine.Machine.InputEvent<M>>,
          ...Array<FastCheck.Arbitrary<Machine.Machine.InputEvent<M>>>
        ]
      ),
      { minLength: minEvents, maxLength: maxEvents }
    ))

  if (machine.input === undefined || machine.input === Schema.Void) {
    if (options.inputArbitrary !== undefined) {
      throw new Error("MachineTest.scenarios cannot override input for a machine without an input schema")
    }
    return {
      arbitrary: eventsArbitrary.map((events) => ({ events }) as Scenario<M>),
      diagnostics: {
        input: "none",
        events: options.eventsArbitrary !== undefined ? "override" : eventArbitraries.length === 0 ? "empty" : "schema",
        schemas: diagnostics
      }
    }
  }

  let inputArbitrary: FastCheck.Arbitrary<InputValue<M>>
  if (options.inputArbitrary !== undefined) {
    inputArbitrary = options.inputArbitrary
  } else {
    const derived = Schema.toArbitrary(machine.input, { report: true })
    diagnostics.unshift({
      boundary: "input",
      index: undefined,
      report: derived.report
    })
    inputArbitrary = derived.value as FastCheck.Arbitrary<InputValue<M>>
  }

  return {
    arbitrary: FastCheck.tuple(inputArbitrary, eventsArbitrary).map(([input, events]) =>
      ({
        input,
        events
      }) as Scenario<M>
    ),
    diagnostics: {
      input: options.inputArbitrary !== undefined ? "override" : "schema",
      events: options.eventsArbitrary !== undefined ? "override" : eventArbitraries.length === 0 ? "empty" : "schema",
      schemas: diagnostics
    }
  }
}

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
  readonly actions: ReadonlyArray<
    Effect.Effect<void, Machine.ActionError<Requirements>, Machine.ActionServices<Requirements>>
  >
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
    readonly actions: ReadonlyArray<
      Effect.Effect<
        void,
        Machine.ActionError<Machine.Machine.InitialServices<M> | Machine.Machine.Services<M>>,
        Machine.ActionServices<Machine.Machine.InitialServices<M> | Machine.Machine.Services<M>>
      >
    >
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
    readonly actions: ReadonlyArray<
      Effect.Effect<
        void,
        Machine.ActionError<Machine.Machine.Services<M>>,
        Machine.ActionServices<Machine.Machine.Services<M>>
      >
    >
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
export const verifyModel = <M extends AnyMachine>(
  model: FiniteModel,
  actualTrace: Trace<M>
): Effect.Effect<void, ReferenceModel.ModelVerificationError> => ReferenceModel.verifyModelTrace(model, actualTrace)

const rawConfigurationPaths = <M extends AnyMachine>(
  machine: M,
  snapshot: Machine.Machine.Snapshot<Machine.Machine.States<M>>
): ReadonlyArray<StatePath<M>> => {
  const active = new Set<string>()
  const visit = (current: unknown): void => {
    if (typeof current !== "object" || current === null) return
    const value = current as Record<string, unknown>
    if (typeof value.path === "string") active.add(value.path)
    if (value.state !== undefined) visit(value.state)
    if (typeof value.states === "object" && value.states !== null) {
      for (const child of Object.values(value.states)) visit(child)
    }
  }
  visit(snapshot)
  return Machine.stateNodes(machine)
    .filter((node) => node.type !== "history" && active.has(node.path))
    .map((node) => node.path) as ReadonlyArray<StatePath<M>>
}

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
) => Effect.Effect<Trace<M>, RunFailure<RunError<M>, M>, RunServices<M>> = Effect.fnUntraced(function*<
  M extends AnyMachine
>(
  machine: ReadyMachine<M>,
  scenario: Scenario<M>
) {
  const initialEffect = (machine.input === undefined || machine.input === Schema.Void
    ? (Machine.planInitial as any)(machine)
    : (Machine.planInitial as any)(machine, (scenario as { readonly input: InputValue<M> }).input)) as Effect.Effect<
      InitialPlan<M>,
      RunError<M>,
      RunServices<M>
    >
  const initial = yield* initialEffect.pipe(
    Effect.mapError((cause): RunFailure<RunError<M>, M> => ({
      _tag: "MachineTestRunFailure",
      scenario,
      phase: "initial",
      eventIndex: undefined,
      event: undefined,
      initial: undefined,
      steps: [],
      cause
    }))
  )
  const initialConfiguration = rawConfigurationPaths(machine, initial.state)
  const initialTrace: InitialTrace<M> = {
    plan: initial,
    startingState: initial.startingState,
    startingConfiguration: rawConfigurationPaths(machine, initial.startingState),
    initialEntryPaths: initial.initialEntryPaths,
    configuration: initialConfiguration
  }
  const steps: Array<TraceStep<M>> = []
  let current = initial.state

  for (let index = 0; index < scenario.events.length; index++) {
    const event = scenario.events[index]
    const before = current
    const beforeConfiguration = rawConfigurationPaths(machine, before)
    const plan = yield* ((Machine.plan as any)(machine, before, event) as Effect.Effect<
      EventPlan<M>,
      RunError<M>,
      RunServices<M>
    >).pipe(
      Effect.mapError((cause): RunFailure<RunError<M>, M> => ({
        _tag: "MachineTestRunFailure",
        scenario,
        phase: "event",
        eventIndex: index,
        event,
        initial: initialTrace,
        steps: steps.slice(),
        cause
      }))
    )
    current = plan.next
    steps.push({
      index,
      before,
      beforeConfiguration,
      event,
      plan,
      after: current,
      afterConfiguration: rawConfigurationPaths(machine, current)
    } as TraceStep<M>)
  }

  return {
    scenario,
    initial: initialTrace,
    steps,
    final: current,
    finalConfiguration: rawConfigurationPaths(machine, current)
  } as Trace<M>
}) as any

const canonicalize = (value: unknown, active: WeakSet<object>): unknown => {
  if (value === undefined) return { $undefined: true }
  if (typeof value === "bigint") return { $bigint: String(value) }
  if (typeof value === "symbol") return { $symbol: String(value) }
  if (typeof value === "function") return { $function: value.name || "anonymous" }
  if (typeof value !== "object" || value === null) return value
  if (active.has(value)) return { $circular: true }
  active.add(value)
  let result: unknown
  if (value instanceof Error) {
    result = {
      $error: value.name,
      message: value.message,
      ...Object.fromEntries(
        Object.keys(value).sort().map((
          key
        ) => [key, canonicalize((value as unknown as Record<string, unknown>)[key], active)])
      )
    }
  } else if (Array.isArray(value)) {
    result = value.map((item) => canonicalize(item, active))
  } else if (value instanceof Date) {
    result = { $date: value.toISOString() }
  } else if (value instanceof Map) {
    result = {
      $map: Array.from(value, ([key, item]) => [canonicalize(key, active), canonicalize(item, active)]).sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b))
      )
    }
  } else if (value instanceof Set) {
    result = {
      $set: Array.from(value, (item) => canonicalize(item, active)).sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b))
      )
    }
  } else {
    result = Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize((value as Record<string, unknown>)[key], active)])
    )
  }
  active.delete(value)
  return result
}

const formatValue = (value: unknown): string => JSON.stringify(canonicalize(value, new WeakSet()))

const structuralFingerprint = (value: unknown): string => {
  const references = new WeakMap<object, number>()
  let nextReference = 0
  const visit = (current: unknown): unknown => {
    if (current === undefined) return ["undefined"]
    if (current === null) return ["null"]
    if (typeof current === "number") {
      if (Number.isNaN(current)) return ["number", "NaN"]
      if (Object.is(current, -0)) return ["number", "-0"]
      return ["number", current]
    }
    if (typeof current === "bigint") return ["bigint", String(current)]
    if (typeof current === "symbol") {
      return [
        "symbol",
        Symbol.keyFor(current) === undefined ? "local" : "global",
        Symbol.keyFor(current) ?? current.description
      ]
    }
    if (typeof current === "function") return ["function", current.name, current.length]
    if (typeof current !== "object") return [typeof current, current]

    const existing = references.get(current)
    if (existing !== undefined) return ["reference", existing]
    const reference = nextReference++
    references.set(current, reference)

    if (Array.isArray(current)) return ["array", reference, current.map(visit)]
    if (current instanceof Date) return ["date", reference, current.getTime()]
    if (current instanceof RegExp) return ["regexp", reference, current.source, current.flags]
    if (current instanceof ArrayBuffer) {
      return ["array-buffer", reference, Array.from(new Uint8Array(current))]
    }
    if (typeof SharedArrayBuffer !== "undefined" && current instanceof SharedArrayBuffer) {
      return ["shared-array-buffer", reference, Array.from(new Uint8Array(current))]
    }
    if (ArrayBuffer.isView(current)) {
      return [
        "array-buffer-view",
        reference,
        current.constructor.name,
        current.byteOffset,
        current.byteLength,
        Array.from(new Uint8Array(current.buffer, current.byteOffset, current.byteLength))
      ]
    }
    if (current instanceof Error) {
      return ["error", reference, current.name, current.message, visit(Object.fromEntries(Object.entries(current)))]
    }
    if (current instanceof Map) {
      return ["map", reference, Array.from(current, ([key, item]) => [visit(key), visit(item)])]
    }
    if (current instanceof Set) return ["set", reference, Array.from(current, visit)]

    const stringKeys = Object.getOwnPropertyNames(current).sort()
    const symbolKeys = Object.getOwnPropertySymbols(current).sort((left, right) =>
      String(Symbol.keyFor(left) ?? left.description).localeCompare(String(Symbol.keyFor(right) ?? right.description))
    )
    return [
      "object",
      reference,
      Object.getPrototypeOf(current)?.constructor?.name ?? null,
      stringKeys.map((key) => [key, visit((current as Record<string, unknown>)[key])]),
      symbolKeys.map((key) => [visit(key), visit((current as Record<symbol, unknown>)[key])])
    ]
  }
  return JSON.stringify(visit(value))
}

const structurallyEqual = (left: unknown, right: unknown): boolean => {
  const leftToRight = new WeakMap<object, object>()
  const rightToLeft = new WeakMap<object, object>()
  const compare = (a: unknown, b: unknown): boolean => {
    if (Object.is(a, b)) return true
    if (typeof a !== typeof b || a === null || b === null) return false
    if (typeof a !== "object" || typeof b !== "object") return false
    const knownRight = leftToRight.get(a)
    const knownLeft = rightToLeft.get(b)
    if (knownRight !== undefined || knownLeft !== undefined) return knownRight === b && knownLeft === a
    leftToRight.set(a, b)
    rightToLeft.set(b, a)

    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false
    if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
    if (a instanceof RegExp && b instanceof RegExp) return a.source === b.source && a.flags === b.flags
    if (a instanceof ArrayBuffer && b instanceof ArrayBuffer) {
      return a.byteLength === b.byteLength &&
        new Uint8Array(a).every((byte, index) => byte === new Uint8Array(b)[index])
    }
    if (
      typeof SharedArrayBuffer !== "undefined" && a instanceof SharedArrayBuffer && b instanceof SharedArrayBuffer
    ) {
      return a.byteLength === b.byteLength &&
        new Uint8Array(a).every((byte, index) => byte === new Uint8Array(b)[index])
    }
    if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
      if (a.constructor !== b.constructor || a.byteOffset !== b.byteOffset || a.byteLength !== b.byteLength) {
        return false
      }
      const leftBytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
      const rightBytes = new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
      return leftBytes.every((byte, index) => byte === rightBytes[index])
    }
    if (a instanceof Error && b instanceof Error && (a.name !== b.name || a.message !== b.message)) return false
    if (a instanceof Map && b instanceof Map) {
      if (a.size !== b.size) return false
      const leftEntries = Array.from(a)
      const rightEntries = Array.from(b)
      return leftEntries.every(([key, item], index) =>
        compare(key, rightEntries[index]![0]) && compare(item, rightEntries[index]![1])
      )
    }
    if (a instanceof Set && b instanceof Set) {
      if (a.size !== b.size) return false
      const rightValues = Array.from(b)
      return Array.from(a).every((item, index) => compare(item, rightValues[index]))
    }
    if (Array.isArray(a) !== Array.isArray(b)) return false
    if (!Array.isArray(a) && Object.getPrototypeOf(a) !== Object.prototype && Object.getPrototypeOf(a) !== null) {
      return false
    }

    const leftKeys = Reflect.ownKeys(a).sort((first, second) => String(first).localeCompare(String(second)))
    const rightKeys = Reflect.ownKeys(b).sort((first, second) => String(first).localeCompare(String(second)))
    return leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) =>
        Object.is(key, rightKeys[index]) && compare(
          (a as Record<PropertyKey, unknown>)[key],
          (b as Record<PropertyKey, unknown>)[rightKeys[index]!]
        )
      )
  }
  return compare(left, right)
}

const makeStructuralIdentityIndex = () => {
  const buckets = new Map<string, Array<{ readonly id: string; readonly value: unknown }>>()
  return (value: unknown): string => {
    const fingerprint = structuralFingerprint(value)
    let bucket = buckets.get(fingerprint)
    if (bucket === undefined) buckets.set(fingerprint, bucket = [])
    const existing = bucket.find((candidate) => structurallyEqual(candidate.value, value))
    if (existing !== undefined) return existing.id
    const id = bucket.length === 0 ? fingerprint : `${fingerprint}#collision:${bucket.length}`
    bucket.push({ id, value })
    return id
  }
}

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
      StatePath<M>,
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

const coverageSummary = <Item>(declared: ReadonlyArray<Item>, hit: ReadonlySet<number>): CoverageSummary<Item> => {
  const hits: Array<Item> = []
  const misses: Array<Item> = []
  declared.forEach((item, index) => (hit.has(index) ? hits : misses).push(item))
  return {
    total: declared.length,
    hit: hits.length,
    missing: misses.length,
    hits,
    misses
  }
}

const normalizeTraces = <M extends AnyMachine>(
  traceOrTraces: Trace<M> | ReadonlyArray<Trace<M>>
): ReadonlyArray<Trace<M>> =>
  Array.isArray(traceOrTraces) ? traceOrTraces as ReadonlyArray<Trace<M>> : [traceOrTraces as Trace<M>]

const sameCoverageTrigger = (
  left: Machine.Machine.TransitionTrigger,
  right: Machine.Machine.TransitionTrigger
): boolean =>
  left.type === right.type && (left.type !== "event" || right.type === "event" && left.event === right.event)

const targetWithinDeclaredBounds = (
  target: string | undefined,
  bounds: Machine.Machine.TransitionTargets
): boolean =>
  target === undefined || bounds.type === "dynamic" ||
  bounds.paths.some((path) => target === path || target.startsWith(`${path}.`))

const finiteTagValues = (ast: SchemaAST.AST): ReadonlyArray<PropertyKey> | undefined => {
  if (SchemaAST.isLiteral(ast)) {
    return typeof ast.literal === "string" || typeof ast.literal === "number" ? [ast.literal] : undefined
  }
  if (SchemaAST.isUniqueSymbol(ast)) return [ast.symbol]
  if (SchemaAST.isUnion(ast)) {
    const values: Array<PropertyKey> = []
    for (const member of ast.types) {
      const memberValues = finiteTagValues(member)
      if (memberValues === undefined) return undefined
      for (const value of memberValues) if (!values.includes(value)) values.push(value)
    }
    return values
  }
  if (SchemaAST.isObjects(ast)) {
    const tag = ast.propertySignatures.find(({ name }) => name === "_tag")?.type
    return tag === undefined ? undefined : finiteTagValues(tag)
  }
  if (SchemaAST.isDeclaration(ast)) {
    const sentinels = ast.annotations?.["~sentinels"]
    if (Array.isArray(sentinels)) {
      const tag = sentinels.find((sentinel): sentinel is { readonly key: "_tag"; readonly literal: PropertyKey } =>
        typeof sentinel === "object" && sentinel !== null && sentinel.key === "_tag" &&
        (typeof sentinel.literal === "string" ||
          typeof sentinel.literal === "number" ||
          typeof sentinel.literal === "symbol")
      )
      if (tag !== undefined) return [tag.literal]
    }
    for (const parameter of ast.typeParameters) {
      const values = finiteTagValues(parameter)
      if (values !== undefined) return values
    }
  }
  if (SchemaAST.isSuspend(ast)) return finiteTagValues(ast.thunk())
  return undefined
}

const publicEventTags = <M extends AnyMachine>(machine: M): {
  readonly tags: ReadonlyArray<Machine.Machine.TagOf<Machine.Machine.InputEvents<M>[number]>>
  readonly diagnostics: ReadonlyArray<{ readonly schemaIndex: number; readonly message: string }>
} => {
  const tags: Array<Machine.Machine.TagOf<Machine.Machine.InputEvents<M>[number]>> = []
  const diagnostics: Array<{ readonly schemaIndex: number; readonly message: string }> = []
  machine.events.forEach((schema, schemaIndex) => {
    const values = finiteTagValues(SchemaAST.toType(schema.ast))
    if (values === undefined) {
      diagnostics.push({
        schemaIndex,
        message: "The decoded _tag schema is not a finite literal, unique symbol, or finite union"
      })
      return
    }
    for (const value of values) {
      const tag = value as Machine.Machine.TagOf<Machine.Machine.InputEvents<M>[number]>
      if (!tags.includes(tag)) tags.push(tag)
    }
  })
  return { tags, diagnostics }
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
export const coverage = <M extends AnyMachine>(
  machine: M,
  traceOrTraces: Trace<M> | ReadonlyArray<Trace<M>>
): Coverage<M> => {
  const traces = normalizeTraces(traceOrTraces)
  const stateNodes = Machine.stateNodes(machine)
  const activeNodes = stateNodes.filter((node) => node.type !== "history").map(
    (node): StateCoverageItem<StatePath<M>> => ({
      path: node.path as StatePath<M>,
      type: node.type as StateCoverageItem["type"]
    })
  )
  const activeIndex = new Map<string, number>(activeNodes.map((node, index) => [node.path, index]))
  const activationHits = new Set<number>()
  const entryHits = new Set<number>()
  const exitHits = new Set<number>()

  const definitions = Machine.transitionDefinitions(machine).map(
    (
      definition,
      index
    ): TransitionCoverageItem<
      StatePath<M>,
      Machine.Machine.TagOf<Machine.Machine.Events<M>[number]>,
      StateNodePath<M>
    > => ({
      id: `transition:${index}:${formatValue(definition)}`,
      index,
      source: definition.source,
      trigger: definition.trigger,
      reenter: definition.reenter,
      targets: definition.targets
    })
  )
  const transitionHits = new Set<number>()

  const declaredEvents = publicEventTags(machine)
  const declaredEventTags = declaredEvents.tags
  const eventCounts = new Map<PropertyKey, number>(declaredEventTags.map((tag) => [tag, 0]))
  const logicalConfigurationIdentities = new Set<string>()
  const logicalConfigurationIdentity = makeStructuralIdentityIndex()
  let configurationObservations = 0
  let scenarioEvents = 0
  let emptyScenarios = 0
  let startupWithMicrosteps = 0
  let microsteps = 0
  let changedMicrosteps = 0
  let targetlessTransitions = 0
  let raisedEvents = 0
  let emittedEvents = 0
  let eventTriggered = 0
  let alwaysTriggered = 0
  let doneTriggered = 0
  let donePlans = 0
  let completionRecordObservations = 0
  const completionPaths = new Set<string>()
  let historyRecordObservations = 0
  const historyModes = new Map<string, Set<"shallow" | "deep">>()
  let historyTargets = 0
  let resolvedHistoryTargets = 0
  const nodeByPath = new Map(stateNodes.map((node) => [node.path, node]))

  const hitPaths = (paths: ReadonlyArray<string>, hits: Set<number>): void => {
    for (const path of paths) {
      const index = activeIndex.get(path)
      if (index !== undefined) hits.add(index)
    }
  }

  const observeSnapshot = (snapshot: Machine.Machine.Snapshot<Machine.Machine.States<M>>): void => {
    const paths = rawConfigurationPaths(machine, snapshot) as ReadonlyArray<string>
    hitPaths(paths, activationHits)
    configurationObservations += 1
    logicalConfigurationIdentities.add(logicalConfigurationIdentity(snapshot))
    const metadata = snapshot as unknown as {
      readonly completed?: ReadonlyArray<{ readonly path: string }>
      readonly history?: Readonly<Record<string, { readonly mode: "shallow" | "deep" }>>
    }
    for (const completion of metadata.completed ?? []) {
      completionRecordObservations += 1
      completionPaths.add(completion.path)
    }
    for (const [path, record] of Object.entries(metadata.history ?? {})) {
      historyRecordObservations += 1
      let modes = historyModes.get(path)
      if (modes === undefined) historyModes.set(path, modes = new Set())
      modes.add(record.mode)
    }
  }

  const observeMicrostep = (microstep: Microstep<M, any>): void => {
    microsteps += 1
    if (microstep.changed) changedMicrosteps += 1
    raisedEvents += microstep.raisedEvents.length
    emittedEvents += microstep.emittedEvents.length
    hitPaths(microstep.entryPaths, entryHits)
    hitPaths(microstep.exitPaths, exitHits)
    observeSnapshot(microstep.next)
    for (const retained of microstep.transitions) {
      if (retained.target === undefined) targetlessTransitions += 1
      if (retained.trigger.type === "event") eventTriggered += 1
      else if (retained.trigger.type === "always") alwaysTriggered += 1
      else doneTriggered += 1
      if (retained.target !== undefined && nodeByPath.get(retained.target)?.type === "history") {
        historyTargets += 1
        if (retained.resolvedTarget !== undefined) resolvedHistoryTargets += 1
      }
      const definitionIndex = definitions.findIndex((definition) =>
        definition.source === retained.source &&
        definition.reenter === retained.reenter &&
        sameCoverageTrigger(definition.trigger, retained.trigger) &&
        targetWithinDeclaredBounds(retained.target, definition.targets)
      )
      if (definitionIndex !== -1) transitionHits.add(definitionIndex)
    }
  }

  for (const trace of traces) {
    scenarioEvents += trace.scenario.events.length
    if (trace.scenario.events.length === 0) emptyScenarios += 1
    for (const event of trace.scenario.events) {
      const tag = event._tag
      eventCounts.set(tag, (eventCounts.get(tag) ?? 0) + 1)
    }

    observeSnapshot(trace.initial.startingState)
    hitPaths(trace.initial.initialEntryPaths, entryHits)
    if (trace.initial.plan.microsteps.length > 0) startupWithMicrosteps += 1
    for (const microstep of trace.initial.plan.microsteps) observeMicrostep(microstep)
    observeSnapshot(trace.initial.plan.state)
    if (trace.initial.plan.done) donePlans += 1

    for (const step of trace.steps) {
      observeSnapshot(step.before)
      for (const microstep of step.plan.microsteps) observeMicrostep(microstep)
      observeSnapshot(step.after)
      if (step.plan.done) donePlans += 1
    }
  }

  const eventItems = declaredEventTags.map((tag): EventCoverageItem<any> => ({
    tag,
    count: eventCounts.get(tag) ?? 0
  }))
  const eventHits = eventItems.filter(({ count }) => count > 0)
  const eventMisses = eventItems.filter(({ count }) => count === 0)

  return {
    states: {
      activation: coverageSummary(activeNodes, activationHits),
      entry: coverageSummary(activeNodes, entryHits),
      exit: coverageSummary(activeNodes, exitHits)
    },
    transitions: coverageSummary(definitions, transitionHits),
    events: declaredEvents.diagnostics.length === 0
      ? {
        available: true,
        total: eventItems.length,
        hit: eventHits.length,
        missing: eventMisses.length,
        hits: eventHits,
        misses: eventMisses,
        observed: eventItems,
        diagnostics: []
      }
      : {
        available: false,
        total: undefined,
        hit: undefined,
        missing: undefined,
        hits: undefined,
        misses: undefined,
        observed: Array.from(eventCounts, ([tag, count]) => ({ tag, count })) as ReadonlyArray<EventCoverageItem<any>>,
        diagnostics: declaredEvents.diagnostics
      },
    scenarios: {
      traces: traces.length,
      events: scenarioEvents,
      empty: emptyScenarios
    },
    logicalConfigurations: {
      observations: configurationObservations,
      hit: logicalConfigurationIdentities.size,
      identities: Array.from(logicalConfigurationIdentities).sort()
    },
    startup: {
      traces: traces.length,
      withMicrosteps: startupWithMicrosteps
    },
    microsteps: {
      total: microsteps,
      changed: changedMicrosteps,
      targetless: targetlessTransitions,
      raised: raisedEvents,
      emitted: emittedEvents,
      eventTriggered,
      alwaysTriggered,
      doneTriggered
    },
    completion: {
      donePlans,
      recordObservations: completionRecordObservations,
      paths: Array.from(completionPaths).sort() as unknown as ReadonlyArray<StatePath<M>>
    },
    history: {
      recordObservations: historyRecordObservations,
      recorded: Array.from(historyModes, ([path, modes]) => ({
        path: path as StateNodePath<M>,
        modes: Array.from(modes).sort()
      })).sort((left, right) => left.path.localeCompare(right.path)),
      targets: historyTargets,
      resolvedTargets: resolvedHistoryTargets
    }
  } as Coverage<M>
}

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

type SnapshotObservationRole = "startup" | "event" | "microstep"

interface SnapshotOccurrence<M extends AnyMachine> {
  readonly snapshot: Machine.Machine.Snapshot<Machine.Machine.States<M>>
  readonly role: SnapshotObservationRole
}

interface GraphMicrostepDraft<M extends AnyMachine> {
  readonly nextOccurrence: number
  readonly microstep: Microstep<M, any>
}

type GraphEdgeDraftData<M extends AnyMachine> = ObservedGraphEdge<M> extends infer Edge
  ? Edge extends ObservedGraphEdge<M> ? Omit<Edge, "microsteps"> & {
      readonly microsteps: ReadonlyArray<GraphMicrostepDraft<M>>
    }
  : never
  : never

interface GraphEdgeDraft<M extends AnyMachine> {
  readonly sourceOccurrence: number
  readonly targetOccurrence: number
  readonly edge: GraphEdgeDraftData<M>
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
> = Effect.fnUntraced(function*<M extends AnyMachine>(
  machine: M,
  traceOrTraces: Trace<M> | ReadonlyArray<Trace<M>>
) {
  const traces = normalizeTraces(traceOrTraces)
  const occurrences: Array<SnapshotOccurrence<M>> = []
  const edgeDrafts: Array<GraphEdgeDraft<M>> = []
  const startOccurrences: Array<number> = []
  const startupSourceOccurrences: Array<number> = []
  const addOccurrence = (
    snapshot: Machine.Machine.Snapshot<Machine.Machine.States<M>>,
    role: SnapshotObservationRole
  ): number => {
    const index = occurrences.length
    occurrences.push({ snapshot, role })
    return index
  }
  const addMicrosteps = (microsteps: ReadonlyArray<Microstep<M, any>>): ReadonlyArray<GraphMicrostepDraft<M>> =>
    microsteps.map((microstep) => ({
      nextOccurrence: addOccurrence(microstep.next, "microstep"),
      microstep
    }))

  traces.forEach((trace, traceIndex) => {
    const start = addOccurrence(trace.initial.startingState, "startup")
    startupSourceOccurrences.push(start)
    const startupMicrosteps = addMicrosteps(trace.initial.plan.microsteps)
    const initialized = addOccurrence(trace.initial.plan.state, "startup")
    startOccurrences.push(initialized)
    edgeDrafts.push({
      sourceOccurrence: start,
      targetOccurrence: initialized,
      edge: {
        _tag: "Startup",
        traceIndex,
        microsteps: startupMicrosteps,
        completion: trace.initial.plan.done
          ? { done: true, output: trace.initial.plan.output }
          : { done: false, output: undefined }
      }
    })

    for (const step of trace.steps) {
      const before = addOccurrence(step.before, "event")
      const stepMicrosteps = addMicrosteps(step.plan.microsteps)
      const after = addOccurrence(step.after, "event")
      edgeDrafts.push({
        sourceOccurrence: before,
        targetOccurrence: after,
        edge: {
          _tag: "Event",
          traceIndex,
          eventIndex: step.index,
          event: step.event,
          microsteps: stepMicrosteps,
          completion: step.plan.done
            ? { done: true, output: step.plan.output }
            : { done: false, output: undefined }
        }
      })
    }
  })

  const encoded = yield* Effect.forEach(
    occurrences,
    ({ snapshot }) =>
      (Machine.encodeSnapshot as any)(machine, snapshot) as Effect.Effect<
        Machine.Machine.EncodedSnapshot,
        Machine.MachineSchemaEncodeError,
        Machine.Machine.SnapshotEncodingServices<Machine.Machine.States<M>>
      >
  )
  const encodedIdentity = makeStructuralIdentityIndex()
  const occurrenceIds = encoded.map(encodedIdentity)
  const grouped = new Map<string, {
    readonly encoded: Machine.Machine.EncodedSnapshot
    readonly snapshot: Machine.Machine.Snapshot<Machine.Machine.States<M>>
    startup: number
    event: number
    microstep: number
  }>()
  occurrences.forEach((occurrence, index) => {
    const id = occurrenceIds[index]!
    let group = grouped.get(id)
    if (group === undefined) {
      grouped.set(
        id,
        group = {
          encoded: encoded[index]!,
          snapshot: occurrence.snapshot,
          startup: 0,
          event: 0,
          microstep: 0
        }
      )
    }
    group[occurrence.role] += 1
  })

  const nodesById = new Map<string, Graph.NodeIndex>()
  const graph = Graph.directed<ObservedGraphNode<M>, ObservedGraphEdge<M>>((mutable) => {
    for (const [id, group] of grouped) {
      const node = Graph.addNode(mutable, {
        id,
        snapshot: group.snapshot,
        encoded: group.encoded,
        configuration: group.encoded.active.map(({ path }) => path) as unknown as ReadonlyArray<StatePath<M>>,
        observations: {
          total: group.startup + group.event + group.microstep,
          startup: group.startup,
          event: group.event,
          microstep: group.microstep
        }
      })
      nodesById.set(id, node)
    }
    for (const draft of edgeDrafts) {
      const source = nodesById.get(occurrenceIds[draft.sourceOccurrence]!)!
      const target = nodesById.get(occurrenceIds[draft.targetOccurrence]!)!
      Graph.addEdge(mutable, source, target, {
        ...draft.edge,
        microsteps: draft.edge.microsteps.map(({ microstep, nextOccurrence }) => ({
          next: occurrenceIds[nextOccurrence]!,
          event: microstep.event,
          transitions: microstep.transitions,
          raisedEvents: microstep.raisedEvents,
          emittedEvents: microstep.emittedEvents,
          exitPaths: microstep.exitPaths as ReadonlyArray<StatePath<M>>,
          entryPaths: microstep.entryPaths as ReadonlyArray<StatePath<M>>,
          changed: microstep.changed
        }))
      } as ObservedGraphEdge<M>)
    }
  })
  return {
    graph,
    nodesById,
    starts: Array.from(new Set(startOccurrences.map((index) => nodesById.get(occurrenceIds[index]!)!))),
    startupSources: Array.from(
      new Set(startupSourceOccurrences.map((index) => nodesById.get(occurrenceIds[index]!)!))
    )
  }
}) as any

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
export class VerificationError extends Data.TaggedError("MachineTestVerificationError")<{
  readonly violations: ReadonlyArray<VerificationViolation>
}> {}

/**
 * Selects law families for the single canonical verifier. All run by default.
 *
 * @category models
 * @since 4.0.0
 */
export interface VerifyOptions {
  readonly laws?: ReadonlyArray<VerificationLawGroup>
}

interface VerificationLocation {
  readonly eventIndex: number | undefined
  readonly microstepIndex?: number
}

interface SnapshotInspection {
  readonly active: ReadonlySet<string>
  readonly paths: ReadonlyArray<string>
  readonly values: ReadonlyMap<string, unknown>
  readonly root: Record<string, unknown> | undefined
}

type PublicStateNode = Machine.Machine.StateNode<string>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const hasOwn = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key)

const sameValue = (left: unknown, right: unknown): boolean => formatValue(left) === formatValue(right)

const samePaths = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((path, index) => path === right[index])

const sameTrigger = (
  left: Machine.Machine.TransitionTrigger,
  right: Machine.Machine.TransitionTrigger
): boolean =>
  left.type === right.type && (left.type !== "event" || right.type === "event" && left.event === right.event)

const makeNodeUtilities = (nodes: ReadonlyArray<PublicStateNode>) => {
  const byPath = new Map(nodes.map((node) => [node.path, node]))
  const depth = (path: string): number => {
    let current = byPath.get(path)
    let result = 0
    const seen = new Set<string>()
    while (current !== undefined && !seen.has(current.path)) {
      seen.add(current.path)
      result += 1
      current = current.parent === undefined ? undefined : byPath.get(current.parent)
    }
    return result
  }
  const isDescendantOrSelf = (path: string, ancestor: string): boolean => {
    let current = byPath.get(path)
    const seen = new Set<string>()
    while (current !== undefined && !seen.has(current.path)) {
      if (current.path === ancestor) return true
      seen.add(current.path)
      current = current.parent === undefined ? undefined : byPath.get(current.parent)
    }
    return false
  }
  const ancestors = (path: string): ReadonlyArray<string> => {
    const result: Array<string> = []
    let current = byPath.get(path)
    const seen = new Set<string>()
    while (current !== undefined && !seen.has(current.path)) {
      seen.add(current.path)
      result.unshift(current.path)
      current = current.parent === undefined ? undefined : byPath.get(current.parent)
    }
    return result
  }
  return { ancestors, byPath, depth, isDescendantOrSelf }
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
export const verify = <M extends AnyMachine>(
  machine: M,
  trace: Trace<M>,
  options: VerifyOptions = {}
): Effect.Effect<void, VerificationError> => {
  const selected = new Set<VerificationLawGroup>(
    options.laws ?? ["configuration", "microsteps", "completion", "history", "targetBounds"]
  )
  const nodes = Machine.stateNodes(machine) as ReadonlyArray<PublicStateNode>
  const definitions = Machine.transitionDefinitions(machine)
  const { ancestors, byPath, depth, isDescendantOrSelf } = makeNodeUtilities(nodes)
  const violations: Array<VerificationViolation> = []

  const add = (
    law: VerificationLaw,
    location: VerificationLocation,
    message: string,
    path?: string
  ): void => {
    violations.push({
      law,
      eventIndex: location.eventIndex,
      ...(location.microstepIndex === undefined ? {} : { microstepIndex: location.microstepIndex }),
      ...(path === undefined ? {} : { path }),
      message
    })
  }

  const schemaMatches = (schema: Schema.Top | undefined, value: unknown): boolean => {
    if (schema === undefined) return false
    try {
      return Schema.is(schema)(value)
    } catch {
      return false
    }
  }

  const inspectSnapshot = (
    snapshot: unknown,
    location: VerificationLocation,
    label: string
  ): SnapshotInspection => {
    const active = new Set<string>()
    const paths: Array<string> = []
    const values = new Map<string, unknown>()
    const reportConfiguration = selected.has("configuration")
    const root = isRecord(snapshot) ? snapshot : undefined

    const visit = (current: unknown, expectedParent: string | undefined, expectedPath?: string): void => {
      if (!isRecord(current)) {
        if (reportConfiguration) {
          add("configuration.shape", location, `${label} must contain an object snapshot`)
        }
        return
      }
      if (typeof current.path !== "string") {
        if (reportConfiguration) {
          add("configuration.path", location, `${label} contains a snapshot without a string path`)
        }
        return
      }
      const path = current.path
      if (active.has(path)) {
        if (reportConfiguration) {
          add("configuration.duplicate", location, `${label} activates state "${path}" more than once`, path)
        }
        return
      }
      active.add(path)
      paths.push(path)
      values.set(path, current.value)

      const node = byPath.get(path)
      if (node === undefined) {
        if (reportConfiguration) {
          add("configuration.path", location, `${label} activates unknown state "${path}"`, path)
        }
        if (isRecord(current.state)) visit(current.state, path)
        if (isRecord(current.states)) {
          for (const child of Object.values(current.states)) visit(child, path)
        }
        return
      }
      if (expectedPath !== undefined && path !== expectedPath && reportConfiguration) {
        add(
          "configuration.hierarchy",
          location,
          `${label} expected region "${expectedPath}" but found "${path}"`,
          path
        )
      }
      if (node.parent !== expectedParent && reportConfiguration) {
        add(
          "configuration.hierarchy",
          location,
          expectedParent === undefined
            ? `${label} root state "${path}" is not a machine root`
            : `${label} state "${path}" is not a direct child of "${expectedParent}"`,
          path
        )
      }
      if (node.type === "history") {
        if (reportConfiguration) {
          add("configuration.path", location, `${label} activates history pseudo-state "${path}"`, path)
        }
        return
      }
      if (reportConfiguration && !schemaMatches(node.schema, current.value)) {
        add("configuration.schema", location, `${label} value for "${path}" does not match its schema`, path)
      }

      if (node.type === "compound") {
        if (!isRecord(current.state)) {
          if (reportConfiguration) {
            add(
              "configuration.compound",
              location,
              `${label} compound state "${path}" must have exactly one child`,
              path
            )
          }
        } else {
          visit(current.state, path)
        }
        if (hasOwn(current, "states") && reportConfiguration) {
          add("configuration.compound", location, `${label} compound state "${path}" contains parallel regions`, path)
        }
        return
      }

      if (node.type === "parallel") {
        if (!isRecord(current.states)) {
          if (reportConfiguration) {
            add("configuration.parallel", location, `${label} parallel state "${path}" has no region map`, path)
          }
          return
        }
        const expectedKeys = new Set<string>()
        for (const childPath of node.children) {
          const child = byPath.get(childPath)
          if (child === undefined) continue
          expectedKeys.add(child.key)
          if (!hasOwn(current.states, child.key)) {
            if (reportConfiguration) {
              add(
                "configuration.parallel",
                location,
                `${label} parallel state "${path}" omits region "${child.key}"`,
                childPath
              )
            }
          } else {
            visit(current.states[child.key], path, child.path)
          }
        }
        for (const key of Object.keys(current.states)) {
          if (!expectedKeys.has(key)) {
            if (reportConfiguration) {
              add(
                "configuration.parallel",
                location,
                `${label} parallel state "${path}" contains extra region "${key}"`,
                path
              )
            }
            visit(current.states[key], path)
          }
        }
        if (hasOwn(current, "state") && reportConfiguration) {
          add("configuration.parallel", location, `${label} parallel state "${path}" contains a compound child`, path)
        }
        return
      }

      if ((hasOwn(current, "state") || hasOwn(current, "states")) && reportConfiguration) {
        add("configuration.shape", location, `${label} leaf state "${path}" contains active children`, path)
      }
    }

    visit(snapshot, undefined)
    return { active, paths, values, root }
  }

  const validateTraceConfiguration = (
    expected: SnapshotInspection,
    actual: ReadonlyArray<string>,
    location: VerificationLocation,
    label: string
  ): void => {
    if (selected.has("configuration") && !samePaths(expected.paths, actual)) {
      add(
        "configuration.trace",
        location,
        `${label} configuration [${actual.join(", ")}] does not match snapshot [${expected.paths.join(", ")}]`
      )
    }
  }

  const validateHistory = (
    snapshot: SnapshotInspection,
    location: VerificationLocation,
    label: string
  ): void => {
    if (!selected.has("history") || snapshot.root === undefined || !hasOwn(snapshot.root, "history")) return
    const history = snapshot.root.history
    if (!isRecord(history)) {
      add("history.record", location, `${label} history metadata must be a record`)
      return
    }
    for (const [historyPath, unknownEntry] of Object.entries(history)) {
      const historyNode = byPath.get(historyPath)
      if (historyNode === undefined || historyNode.type !== "history" || historyNode.parent === undefined) {
        add("history.path", location, `${label} contains unknown history record "${historyPath}"`, historyPath)
        continue
      }
      if (!isRecord(unknownEntry)) {
        add("history.record", location, `${label} history record "${historyPath}" must be an object`, historyPath)
        continue
      }
      const entry = unknownEntry
      if (entry.mode !== historyNode.history) {
        add(
          "history.mode",
          location,
          `${label} history record "${historyPath}" has mode "${
            String(entry.mode)
          }", expected "${historyNode.history}"`,
          historyPath
        )
      }
      if (!Array.isArray(entry.active) || !entry.active.every((path) => typeof path === "string")) {
        add(
          "history.record",
          location,
          `${label} history record "${historyPath}" must contain string paths`,
          historyPath
        )
        continue
      }
      if (!isRecord(entry.values)) {
        add(
          "history.record",
          location,
          `${label} history record "${historyPath}" must contain a values record`,
          historyPath
        )
        continue
      }

      const rememberedPaths = entry.active as ReadonlyArray<string>
      const remembered = new Set<string>()
      for (const path of rememberedPaths) {
        if (remembered.has(path)) {
          add("history.path", location, `${label} history record "${historyPath}" repeats "${path}"`, path)
          continue
        }
        remembered.add(path)
        const node = byPath.get(path)
        if (node === undefined || node.type === "history") {
          add(
            "history.path",
            location,
            `${label} history record "${historyPath}" contains invalid state "${path}"`,
            path
          )
          continue
        }
        const inOwnerSubtree = isDescendantOrSelf(path, historyNode.parent)
        const inOwnerAncestry = ancestors(historyNode.parent).includes(path)
        if (!inOwnerSubtree && !inOwnerAncestry) {
          add(
            "history.path",
            location,
            `${label} history record "${historyPath}" contains state "${path}" outside its owner`,
            path
          )
        }
        if (!hasOwn(entry.values, path)) {
          add("history.value", location, `${label} history record "${historyPath}" omits value for "${path}"`, path)
        } else if (!schemaMatches(node.schema, entry.values[path])) {
          add(
            "history.value",
            location,
            `${label} history value for "${path}" does not match its state schema`,
            path
          )
        }
        if (
          entry.mode === "shallow" && isDescendantOrSelf(path, historyNode.parent) && path !== historyNode.parent &&
          node.parent !== historyNode.parent
        ) {
          add(
            "history.shallow",
            location,
            `${label} shallow history record "${historyPath}" contains deep descendant "${path}"`,
            path
          )
        }
      }
      for (const path of Object.keys(entry.values)) {
        if (!remembered.has(path)) {
          add("history.value", location, `${label} history record "${historyPath}" has extra value "${path}"`, path)
        }
      }
      if (entry.mode === "deep") {
        for (const path of remembered) {
          if (!isDescendantOrSelf(path, historyNode.parent) || path === historyNode.parent) continue
          let parent: string | undefined = byPath.get(path)?.parent
          while (parent !== undefined && isDescendantOrSelf(parent, historyNode.parent)) {
            if (!remembered.has(parent)) {
              add(
                "history.deep",
                location,
                `${label} deep history record "${historyPath}" remembers "${path}" without ancestor "${parent}"`,
                path
              )
            }
            if (parent === historyNode.parent) break
            parent = byPath.get(parent)?.parent
          }
        }
      }
      for (const ancestor of ancestors(historyNode.parent)) {
        if (!remembered.has(ancestor)) {
          add(
            "history.path",
            location,
            `${label} history record "${historyPath}" omits owner ancestry state "${ancestor}"`,
            ancestor
          )
        }
      }

      const validateRememberedControl = (path: string, recurse: boolean): void => {
        const node = byPath.get(path)
        if (node === undefined) return
        const activeChildren = node.children.filter((child) => remembered.has(child))
        if (node.type === "compound") {
          if (activeChildren.length !== 1) {
            add(
              entry.mode === "deep" ? "history.deep" : "history.shallow",
              location,
              `${label} history record "${historyPath}" must remember one child of compound state "${path}"`,
              path
            )
          } else if (recurse) {
            validateRememberedControl(activeChildren[0], true)
          }
        } else if (node.type === "parallel") {
          for (const child of node.children) {
            if (!remembered.has(child)) {
              add(
                entry.mode === "deep" ? "history.deep" : "history.shallow",
                location,
                `${label} history record "${historyPath}" omits parallel region "${child}"`,
                child
              )
            } else if (recurse) {
              validateRememberedControl(child, true)
            }
          }
        }
      }
      validateRememberedControl(historyNode.parent, entry.mode === "deep")
    }
  }

  const isCompletedControl = (path: string, active: ReadonlySet<string>): boolean => {
    if (!active.has(path)) return false
    const node = byPath.get(path)
    if (node === undefined) return false
    if (node.type === "final") return true
    if (node.type === "compound") {
      const child = node.children.find((candidate) => active.has(candidate))
      return child !== undefined && byPath.get(child)?.type === "final"
    }
    if (node.type === "parallel") {
      return node.children.length > 0 && node.children.every((child) => isCompletedControl(child, active))
    }
    return false
  }

  const completionSchema = (path: string, active: ReadonlySet<string>): Schema.Top | undefined => {
    const node = byPath.get(path)
    if (node === undefined) return undefined
    if (node.type === "compound") {
      const child = node.children.find((candidate) => active.has(candidate))
      return child === undefined ? undefined : completionSchema(child, active)
    }
    return node.output ?? Schema.Void
  }

  const validateCompletions = (
    snapshot: SnapshotInspection,
    location: VerificationLocation,
    label: string,
    settled: boolean
  ): ReadonlyMap<string, unknown> => {
    const result = new Map<string, unknown>()
    if (!selected.has("completion") || snapshot.root === undefined) {
      return result
    }
    if (hasOwn(snapshot.root, "completed")) {
      const completed = snapshot.root.completed
      if (!Array.isArray(completed)) {
        add("completion.record", location, `${label} completed metadata must be an array`)
      } else {
        for (const unknownEntry of completed) {
          if (!isRecord(unknownEntry) || typeof unknownEntry.path !== "string") {
            add("completion.record", location, `${label} contains an invalid completion record`)
            continue
          }
          const path = unknownEntry.path
          if (result.has(path)) {
            add("completion.record", location, `${label} repeats completion "${path}"`, path)
            continue
          }
          result.set(path, unknownEntry.output)
          if (!snapshot.active.has(path) || !isCompletedControl(path, snapshot.active)) {
            add("completion.record", location, `${label} completion "${path}" is not actively complete`, path)
            continue
          }
          const schema = completionSchema(path, snapshot.active)
          if (!schemaMatches(schema, unknownEntry.output)) {
            add(
              "completion.output",
              location,
              `${label} completion output for "${path}" does not match its schema`,
              path
            )
          }
        }
      }
    }
    if (settled) {
      for (const path of snapshot.paths) {
        if (isCompletedControl(path, snapshot.active) && !result.has(path)) {
          add("completion.record", location, `${label} omits settled completion "${path}"`, path)
        }
      }
    }
    return result
  }

  const validateSnapshotMetadata = (
    snapshot: SnapshotInspection,
    location: VerificationLocation,
    label: string,
    settled = false
  ): ReadonlyMap<string, unknown> => {
    validateHistory(snapshot, location, label)
    return validateCompletions(snapshot, location, label, settled)
  }

  const sameControl = (left: SnapshotInspection, right: SnapshotInspection): boolean => {
    if (!samePaths(left.paths, right.paths)) return false
    for (const path of left.paths) {
      if (!sameValue(left.values.get(path), right.values.get(path))) return false
    }
    return sameValue(left.root?.history, right.root?.history)
  }

  const sameActivePaths = (left: SnapshotInspection, right: SnapshotInspection): boolean =>
    left.active.size === right.active.size && Array.from(left.active).every((path) => right.active.has(path))

  const sortedPaths = (paths: ReadonlyArray<string>, direction: "entry" | "exit"): ReadonlyArray<string> =>
    [...new Set(paths)].sort((left, right) => {
      const depthDifference = direction === "entry" ? depth(left) - depth(right) : depth(right) - depth(left)
      if (depthDifference !== 0) return depthDifference
      const leftOrder = byPath.get(left)?.order ?? Number.MAX_SAFE_INTEGER
      const rightOrder = byPath.get(right)?.order ?? Number.MAX_SAFE_INTEGER
      return direction === "entry" ? leftOrder - rightOrder : rightOrder - leftOrder
    })

  const validateTransitionBounds = (
    transition: Microstep<M>["transitions"][number],
    location: VerificationLocation
  ): void => {
    if (!selected.has("targetBounds")) return
    const definition = definitions.find((candidate) =>
      candidate.source === transition.source && candidate.reenter === transition.reenter &&
      sameTrigger(candidate.trigger, transition.trigger)
    )
    if (definition === undefined) {
      add(
        "targetBounds.definition",
        location,
        `retained transition from "${transition.source}" has no public definition`,
        transition.source
      )
      return
    }
    if (transition.target === undefined || definition.targets.type === "dynamic") return
    if (!definition.targets.paths.some((bound) => isDescendantOrSelf(String(transition.target), String(bound)))) {
      add(
        "targetBounds.target",
        location,
        `transition target "${String(transition.target)}" is outside declared bounds ` +
          `[${definition.targets.paths.join(", ")}]`,
        String(transition.target)
      )
    }
  }

  const validateMicrostep = (
    microstep: Microstep<M, any>,
    before: SnapshotInspection,
    after: SnapshotInspection,
    location: VerificationLocation
  ): void => {
    if (selected.has("microsteps")) {
      const uniqueExit = new Set(microstep.exitPaths)
      const uniqueEntry = new Set(microstep.entryPaths)
      const reentering = microstep.transitions.filter((transition) => transition.reenter)
      const inReentryScope = (
        path: string,
        transition: Microstep<M>["transitions"][number]
      ): boolean => {
        const target = transition.target === undefined ? undefined : byPath.get(String(transition.target))
        if (target?.type === "history" && target.parent !== undefined && before.active.has(target.parent)) {
          return isDescendantOrSelf(path, target.parent)
        }
        const parent = byPath.get(String(transition.source))?.parent
        return parent === undefined || path !== parent && isDescendantOrSelf(path, parent)
      }
      const commonLifecycleExplained = (path: string): boolean =>
        microstep.transitions.some((transition) => {
          if (transition.reenter) {
            const target = transition.target === undefined ? undefined : byPath.get(String(transition.target))
            if (target?.type === "history" && target.parent !== undefined && before.active.has(target.parent)) {
              // Reentry into an active history owner has a dedicated boundary:
              // only the owner subtree is exited and entered, regardless of
              // the ordinary source/resolved-target LCA.
              return isDescendantOrSelf(path, target.parent)
            }
            if (inReentryScope(path, transition)) return true
          }
          if (transition.resolvedTarget === undefined) return false
          const sourceAncestors = ancestors(String(transition.source))
          const targetAncestors = ancestors(String(transition.resolvedTarget))
          let boundary: string | undefined
          for (let index = 0; index < Math.min(sourceAncestors.length, targetAncestors.length); index++) {
            if (sourceAncestors[index] !== targetAncestors[index]) break
            boundary = sourceAncestors[index]
          }
          return boundary === undefined || path !== boundary && isDescendantOrSelf(path, boundary)
        })
      if (uniqueExit.size !== microstep.exitPaths.length) {
        add("microsteps.unique", location, "microstep exit paths contain duplicates")
      }
      if (uniqueEntry.size !== microstep.entryPaths.length) {
        add("microsteps.unique", location, "microstep entry paths contain duplicates")
      }
      if (!samePaths(microstep.exitPaths, sortedPaths(microstep.exitPaths, "exit"))) {
        add("microsteps.order", location, "microstep exit paths are not deepest-first in reverse document order")
      }
      if (!samePaths(microstep.entryPaths, sortedPaths(microstep.entryPaths, "entry"))) {
        add("microsteps.order", location, "microstep entry paths are not parent-first in document order")
      }
      for (const path of microstep.exitPaths) {
        if (!before.active.has(path)) {
          add("microsteps.activeBefore", location, `microstep exits inactive state "${path}"`, path)
        }
      }
      for (const path of microstep.entryPaths) {
        if (!after.active.has(path)) {
          add("microsteps.activeAfter", location, `microstep enters state "${path}" absent from its next state`, path)
        }
      }
      for (const path of before.paths) {
        if (!after.active.has(path) && !uniqueExit.has(path)) {
          add("microsteps.activeBefore", location, `removed state "${path}" is missing from exit paths`, path)
        }
      }
      for (const path of after.paths) {
        if (!before.active.has(path) && !uniqueEntry.has(path)) {
          add("microsteps.activeAfter", location, `added state "${path}" is missing from entry paths`, path)
        }
      }
      for (const transition of reentering) {
        for (const path of before.paths) {
          if (inReentryScope(path, transition) && !uniqueExit.has(path)) {
            add(
              "microsteps.reentry",
              location,
              `reentering transition from "${String(transition.source)}" omits exit lifecycle for "${path}"`,
              path
            )
          }
        }
        for (const path of after.paths) {
          if (inReentryScope(path, transition) && !uniqueEntry.has(path)) {
            add(
              "microsteps.reentry",
              location,
              `reentering transition from "${String(transition.source)}" omits entry lifecycle for "${path}"`,
              path
            )
          }
        }
      }
      for (const path of before.paths) {
        if (!after.active.has(path) || !uniqueExit.has(path) && !uniqueEntry.has(path)) continue
        if (!commonLifecycleExplained(path)) {
          add(
            "microsteps.reentry",
            location,
            `common state "${path}" has lifecycle without a reentering transition`,
            path
          )
        } else if (!uniqueExit.has(path) || !uniqueEntry.has(path)) {
          add(
            "microsteps.reentry",
            location,
            `reentered common state "${path}" must have both exit and entry lifecycle`,
            path
          )
        }
      }
      if (!microstep.changed) {
        if (microstep.exitPaths.length > 0 || microstep.entryPaths.length > 0) {
          add("microsteps.changed", location, "unchanged microstep contains entry or exit paths")
        }
        if (!sameActivePaths(before, after)) {
          add("microsteps.changed", location, "unchanged microstep changes its active state paths")
        }
      } else if (
        microstep.exitPaths.length === 0 && microstep.entryPaths.length === 0 && sameActivePaths(before, after)
      ) {
        add("microsteps.changed", location, "changed microstep has no control-state change or reentry evidence")
      }
      for (const transition of microstep.transitions) {
        if (!before.active.has(String(transition.source))) {
          add(
            "microsteps.activeBefore",
            location,
            `transition source "${String(transition.source)}" is inactive before the microstep`,
            String(transition.source)
          )
        }
        if (
          transition.resolvedTarget !== undefined && !after.active.has(String(transition.resolvedTarget)) &&
          microstep.transitions.length === 1
        ) {
          add(
            "microsteps.activeAfter",
            location,
            `resolved target "${String(transition.resolvedTarget)}" is inactive after the microstep`,
            String(transition.resolvedTarget)
          )
        }
      }
    }
    for (const transition of microstep.transitions) validateTransitionBounds(transition, location)
  }

  const validatePlanCompletion = (
    plan: PlanCompletion<M>,
    snapshot: SnapshotInspection,
    completions: ReadonlyMap<string, unknown>,
    location: VerificationLocation,
    label: string
  ): void => {
    if (!selected.has("completion")) return
    const rootPath = snapshot.paths.find((path) => byPath.get(path)?.parent === undefined)
    const hasRootDoneTransition = rootPath !== undefined &&
      definitions.some((definition) => definition.source === rootPath && definition.trigger.type === "done")
    const terminal = rootPath !== undefined && isCompletedControl(rootPath, snapshot.active) && !hasRootDoneTransition
    if (plan.done !== terminal) {
      add(
        "completion.done",
        location,
        `${label} reports done=${String(plan.done)} for terminal=${String(terminal)}`,
        rootPath
      )
    }
    if (plan.done) {
      if (rootPath === undefined || !completions.has(rootPath)) {
        add("completion.output", location, `${label} done plan has no root completion output`, rootPath)
      } else if (!sameValue(plan.output, completions.get(rootPath))) {
        add("completion.output", location, `${label} output differs from its root completion`, rootPath)
      }
    } else if (plan.output !== undefined) {
      add("completion.output", location, `${label} non-done plan exposes an output`, rootPath)
    }
  }

  const initialLocation: VerificationLocation = { eventIndex: undefined }
  const starting = inspectSnapshot(trace.initial.startingState, initialLocation, "initial starting state")
  validateSnapshotMetadata(starting, initialLocation, "initial starting state")
  validateTraceConfiguration(
    starting,
    trace.initial.startingConfiguration as ReadonlyArray<string>,
    initialLocation,
    "initial starting"
  )
  if (selected.has("microsteps")) {
    if (new Set(trace.initial.initialEntryPaths).size !== trace.initial.initialEntryPaths.length) {
      add("microsteps.unique", initialLocation, "initial entry paths contain duplicates")
    }
    if (!samePaths(trace.initial.initialEntryPaths as ReadonlyArray<string>, starting.paths)) {
      add(
        "microsteps.order",
        initialLocation,
        "initial entry paths do not cover the starting configuration in definition order"
      )
    }
  }

  let current = starting
  for (let index = 0; index < trace.initial.plan.microsteps.length; index++) {
    const location: VerificationLocation = { eventIndex: undefined, microstepIndex: index }
    const microstep = trace.initial.plan.microsteps[index]
    const next = inspectSnapshot(microstep.next, location, `initial microstep ${index} next state`)
    validateSnapshotMetadata(next, location, `initial microstep ${index} next state`)
    validateMicrostep(microstep, current, next, location)
    current = next
  }
  const initialState = inspectSnapshot(trace.initial.plan.state, initialLocation, "initial plan state")
  const initialCompletions = validateSnapshotMetadata(initialState, initialLocation, "initial plan state", true)
  if (selected.has("microsteps") && !sameControl(current, initialState)) {
    add("microsteps.continuity", initialLocation, "initial plan state does not continue from its final microstep")
  }
  validatePlanCompletion(trace.initial.plan, initialState, initialCompletions, initialLocation, "initial plan")
  validateTraceConfiguration(
    initialState,
    trace.initial.configuration as ReadonlyArray<string>,
    initialLocation,
    "initial"
  )
  if (selected.has("microsteps") && !sameValue(trace.initial.startingState, trace.initial.plan.startingState)) {
    add("microsteps.continuity", initialLocation, "initial trace starting state differs from its plan")
  }
  if (
    selected.has("microsteps") &&
    !samePaths(trace.initial.initialEntryPaths as ReadonlyArray<string>, trace.initial.plan.initialEntryPaths)
  ) {
    add("microsteps.continuity", initialLocation, "initial trace entry paths differ from its plan")
  }

  let previous = initialState
  for (let eventIndex = 0; eventIndex < trace.steps.length; eventIndex++) {
    const step = trace.steps[eventIndex]
    const location: VerificationLocation = { eventIndex }
    const before = inspectSnapshot(step.before, location, `event ${eventIndex} before state`)
    validateSnapshotMetadata(before, location, `event ${eventIndex} before state`, true)
    validateTraceConfiguration(
      before,
      step.beforeConfiguration as ReadonlyArray<string>,
      location,
      `event ${eventIndex} before`
    )
    if (selected.has("microsteps")) {
      if (step.index !== eventIndex) {
        add("microsteps.continuity", location, `trace step index ${step.index} does not equal ${eventIndex}`)
      }
      if (!sameValue(previous.root, before.root)) {
        add("microsteps.continuity", location, `event ${eventIndex} before state does not equal the previous state`)
      }
      if (!sameValue(step.event, trace.scenario.events[eventIndex])) {
        add("microsteps.continuity", location, `event ${eventIndex} differs from its scenario event`)
      }
    }

    current = before
    for (let microstepIndex = 0; microstepIndex < step.plan.microsteps.length; microstepIndex++) {
      const microstepLocation: VerificationLocation = { eventIndex, microstepIndex }
      const microstep = step.plan.microsteps[microstepIndex]
      const next = inspectSnapshot(
        microstep.next,
        microstepLocation,
        `event ${eventIndex} microstep ${microstepIndex} next state`
      )
      validateSnapshotMetadata(next, microstepLocation, `event ${eventIndex} microstep ${microstepIndex} next state`)
      validateMicrostep(microstep, current, next, microstepLocation)
      current = next
    }

    const plannedNext = inspectSnapshot(step.plan.next, location, `event ${eventIndex} plan next state`)
    const completions = validateSnapshotMetadata(plannedNext, location, `event ${eventIndex} plan next state`, true)
    if (selected.has("microsteps") && !sameControl(current, plannedNext)) {
      add(
        "microsteps.continuity",
        location,
        `event ${eventIndex} plan next state does not continue its final microstep`
      )
    }
    validatePlanCompletion(step.plan, plannedNext, completions, location, `event ${eventIndex} plan`)

    const after = inspectSnapshot(step.after, location, `event ${eventIndex} after state`)
    validateSnapshotMetadata(after, location, `event ${eventIndex} after state`, true)
    validateTraceConfiguration(
      after,
      step.afterConfiguration as ReadonlyArray<string>,
      location,
      `event ${eventIndex} after`
    )
    if (selected.has("microsteps") && !sameValue(step.plan.next, step.after)) {
      add("microsteps.continuity", location, `event ${eventIndex} after state differs from its plan next state`)
    }
    previous = after
  }

  const finalEventIndex = trace.steps.length === 0 ? undefined : trace.steps.length - 1
  const finalLocation: VerificationLocation = { eventIndex: finalEventIndex }
  const final = inspectSnapshot(trace.final, finalLocation, "trace final state")
  validateSnapshotMetadata(final, finalLocation, "trace final state", true)
  validateTraceConfiguration(final, trace.finalConfiguration as ReadonlyArray<string>, finalLocation, "final")
  if (selected.has("microsteps") && !sameValue(previous.root, final.root)) {
    add("microsteps.continuity", finalLocation, "trace final state differs from its final planned state")
  }

  return violations.length === 0 ? Effect.void : Effect.fail(new VerificationError({ violations }))
}

const formatConfiguration = (paths: ReadonlyArray<string>): string => `[${paths.join(", ")}]`

const formatMicrosteps = <M extends AnyMachine>(microsteps: ReadonlyArray<Microstep<M, any>>): Array<string> =>
  microsteps.map((microstep, index) => {
    const transitions = microstep.transitions.map((transition) => ({
      source: transition.source,
      trigger: transition.trigger,
      reenter: transition.reenter,
      target: transition.target,
      resolvedTarget: transition.resolvedTarget
    }))
    return `  microstep ${index}: event=${formatValue(microstep.event)} changed=${String(microstep.changed)} ` +
      `transitions=${formatValue(transitions)} exit=${formatConfiguration(microstep.exitPaths)} ` +
      `entry=${formatConfiguration(microstep.entryPaths)} actions=${microstep.actions.length} ` +
      `raised=${formatValue(microstep.raisedEvents)} emitted=${formatValue(microstep.emittedEvents)} ` +
      `next=${formatValue(microstep.next)}`
  })

const formatInitial = <M extends AnyMachine>(initial: InitialTrace<M>): Array<string> => [
  `initial: startingConfiguration=${formatConfiguration(initial.startingConfiguration)} ` +
  `startingState=${formatValue(initial.startingState)} initialEntry=${
    formatConfiguration(initial.initialEntryPaths)
  } ` +
  `configuration=${formatConfiguration(initial.configuration)} state=${formatValue(initial.plan.state)} ` +
  `done=${String(initial.plan.done)} output=${formatValue(initial.plan.output)} ` +
  `actions=${initial.plan.actions.length} emitted=${formatValue(initial.plan.emittedEvents)}`,
  ...formatMicrosteps(initial.plan.microsteps)
]

const formatStep = <M extends AnyMachine>(step: TraceStep<M>): Array<string> => [
  `step ${step.index}: event=${formatValue(step.event)} before=${formatConfiguration(step.beforeConfiguration)} ` +
  `after=${formatConfiguration(step.afterConfiguration)} state=${formatValue(step.after)} ` +
  `done=${String(step.plan.done)} output=${formatValue(step.plan.output)} ` +
  `actions=${step.plan.actions.length} emitted=${formatValue(step.plan.emittedEvents)}`,
  ...formatMicrosteps(step.plan.microsteps)
]

const isRunFailure = <M extends AnyMachine, Cause>(
  trace: Trace<M> | RunFailure<Cause, M>
): trace is RunFailure<Cause, M> => "_tag" in trace && trace._tag === "MachineTestRunFailure"

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
export const formatTrace = <M extends AnyMachine, Cause>(trace: Trace<M> | RunFailure<Cause, M>): string => {
  const lines = [`scenario: ${formatValue(trace.scenario)}`]
  if (isRunFailure(trace)) {
    if (trace.initial !== undefined) {
      lines.push(...formatInitial(trace.initial))
      for (const step of trace.steps) {
        lines.push(...formatStep(step))
      }
    }
    lines.push(
      `failure: phase=${trace.phase} eventIndex=${formatValue(trace.eventIndex)} ` +
        `event=${formatValue(trace.event)} cause=${formatValue(trace.cause)}`
    )
    return lines.join("\n")
  }
  lines.push(...formatInitial(trace.initial))
  for (const step of trace.steps) {
    lines.push(...formatStep(step))
  }
  lines.push(`final: configuration=${formatConfiguration(trace.finalConfiguration)} state=${formatValue(trace.final)}`)
  return lines.join("\n")
}
