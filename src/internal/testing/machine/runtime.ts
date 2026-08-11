/**
 * Effect-native command-model testing for live machine references.
 *
 * @since 0.4.0
 */

import * as Cause from "effect/Cause"
import * as Data from "effect/Data"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Inspectable from "effect/Inspectable"
import * as Queue from "effect/Queue"
import * as Stream from "effect/Stream"
import { FastCheck, TestClock } from "effect/testing"
import * as Machine from "../../../Machine.js"
import type { CausalRuntimeEvidence, Probe, ProbeStep, RuntimeInvariant } from "../../../testing/MachineTest.js"
import { type SchemaArbitraryReport, toArbitraryWithReport } from "./arbitrary.js"
import { assertRuntimeInvariants, type RuntimeInvariantError } from "./runtimeInvariant.js"

type AnyMachine = Machine.Machine.Any

/**
 * A command applied to a running machine during model-based testing.
 *
 * @category models
 * @since 0.4.0
 */
export type RuntimeCommand<Event> =
  | {
    readonly _tag: "Send"
    readonly event: Event
  }
  | {
    readonly _tag: "Advance"
    readonly duration: Duration.Input
  }
  | {
    readonly _tag: "Stop"
  }
  | {
    readonly _tag: "Checkpoint"
    readonly label: string | undefined
  }

/**
 * Constructs a command that sends one public event.
 *
 * @category constructors
 * @since 0.4.0
 */
export const sendCommand = <Event>(event: Event): RuntimeCommand<Event> => ({
  _tag: "Send",
  event
})

/**
 * Constructs a command that advances Effect's `TestClock`.
 *
 * @category constructors
 * @since 0.4.0
 */
export const advanceCommand = <Event = never>(duration: Duration.Input): RuntimeCommand<Event> => ({
  _tag: "Advance",
  duration
})

/**
 * Constructs an idempotent command that stops the machine.
 *
 * @category constructors
 * @since 0.4.0
 */
export const stopCommand = <Event = never>(): RuntimeCommand<Event> => ({ _tag: "Stop" })

/**
 * Constructs a no-op command used to synchronize with work enqueued by earlier
 * commands. Its behavior is selected by the reference-model step.
 *
 * @category constructors
 * @since 0.4.0
 */
export const checkpointCommand = <Event = never>(label?: string): RuntimeCommand<Event> => ({
  _tag: "Checkpoint",
  label
})

/**
 * The result of executing one runtime command.
 *
 * @category models
 * @since 0.4.0
 */
export type RuntimeCommandResult =
  | { readonly _tag: "SendAccepted" }
  | { readonly _tag: "SendRejected"; readonly error: Machine.StoppedError }
  | { readonly _tag: "ClockAdvanced" }
  | { readonly _tag: "Stopped" }
  | { readonly _tag: "Checkpoint" }

/**
 * Defines how a model step synchronizes with public machine observations.
 *
 * `None` is appropriate when a send is intentionally only enqueued. `Next`
 * consumes the next snapshot published after the previously consumed one.
 * `Until` also consumes intermediate snapshots and is useful for a checkpoint
 * after several queued sends. `Current` is only a sample; it should be used
 * when the model already knows there is no outstanding asynchronous work.
 *
 * @category models
 * @since 0.4.0
 */
export type RuntimeSynchronization<State, Error, Output> =
  | { readonly _tag: "None" }
  | { readonly _tag: "Current" }
  | { readonly _tag: "Next" }
  | {
    readonly _tag: "Until"
    readonly predicate: (snapshot: Machine.RuntimeSnapshot<State, Error, Output>) => boolean
  }

/**
 * Constructors for runtime synchronization policies.
 *
 * @category constructors
 * @since 0.4.0
 */
export const RuntimeSynchronization = {
  none: { _tag: "None" } as const,
  current: { _tag: "Current" } as const,
  next: { _tag: "Next" } as const,
  until: <State, Error = never, Output = never>(
    predicate: (snapshot: Machine.RuntimeSnapshot<State, Error, Output>) => boolean
  ): RuntimeSynchronization<State, Error, Output> => ({ _tag: "Until", predicate })
} as const

/**
 * The pure/reference-model result for one runtime command.
 *
 * @category models
 * @since 0.4.0
 */
export interface RuntimeModelStep<Model, Expected, State, Error, Output> {
  readonly model: Model
  readonly expected: Expected
  readonly synchronize: RuntimeSynchronization<State, Error, Output>
}

/**
 * Explicit name for the model step used by the enqueue-oriented command
 * runner. The `RuntimeModelStep` name remains as a compatibility alias.
 *
 * @category models
 * @since 0.4.0
 */
export type EnqueuedRuntimeModelStep<Model, Expected, State, Error, Output> = RuntimeModelStep<
  Model,
  Expected,
  State,
  Error,
  Output
>

/**
 * Additional asynchronous observation requested after a causal command has
 * completed. `None` never guesses that later invoke, timer, or child work is
 * finished. `Until` observes the current runtime snapshot and subsequent
 * publications until its predicate matches.
 *
 * @category models
 * @since 0.4.0
 */
export type RuntimeAwait<State, Error, Output> =
  | { readonly _tag: "None" }
  | {
    readonly _tag: "Until"
    readonly predicate: (snapshot: Machine.RuntimeSnapshot<State, Error, Output>) => boolean
  }

/**
 * The pure/reference-model result for one causally executed command.
 *
 * `await` is only for asynchronous behavior after the command boundary. A
 * submitted `Send` always completes its exact managed macrostep first.
 *
 * @category models
 * @since 0.4.0
 */
export interface CausalRuntimeModelStep<Model, Expected, State, Error, Output> {
  readonly model: Model
  readonly expected: Expected
  readonly await?: RuntimeAwait<State, Error, Output>
}

/**
 * Exact execution result for one causal runtime command.
 *
 * @category models
 * @since 0.4.0
 */
export type CausalRuntimeCommandResult<M extends AnyMachine> =
  | { readonly _tag: "SendProcessed"; readonly step: ProbeStep<M> }
  | { readonly _tag: "SendRejected"; readonly error: Machine.StoppedError }
  | { readonly _tag: "ClockAdvanced" }
  | { readonly _tag: "Stopped" }
  | { readonly _tag: "Checkpoint" }

/**
 * Actual causal evidence made available to inspection and assertions.
 *
 * @category models
 * @since 0.4.0
 */
export interface CausalRuntimeCommandActual<
  M extends AnyMachine,
  Error,
  Output,
  Observed
> {
  readonly result: CausalRuntimeCommandResult<M>
  readonly snapshot: Machine.RuntimeSnapshot<Machine.Machine.Snapshot<Machine.Machine.States<M>>, Error, Output>
  /** Snapshots tested by an explicit `RuntimeAwait.until`, including its current snapshot. */
  readonly awaited: ReadonlyArray<
    Machine.RuntimeSnapshot<Machine.Machine.Snapshot<Machine.Machine.States<M>>, Error, Output>
  >
  readonly inspected: Observed | undefined
}

/**
 * Context supplied to a custom causal runtime inspection effect.
 *
 * @category models
 * @since 0.4.0
 */
export interface CausalRuntimeInspectionContext<M extends AnyMachine, Error, Output> {
  readonly index: number
  readonly command: RuntimeCommand<Machine.Machine.InputEvent<M>>
  readonly result: CausalRuntimeCommandResult<M>
  readonly probe: Probe<M, Error, Output>
  readonly ref: Probe<M, Error, Output>["ref"]
  readonly snapshot: Machine.RuntimeSnapshot<Machine.Machine.Snapshot<Machine.Machine.States<M>>, Error, Output>
  readonly awaited: ReadonlyArray<
    Machine.RuntimeSnapshot<Machine.Machine.Snapshot<Machine.Machine.States<M>>, Error, Output>
  >
}

/**
 * Context supplied to a causal reference-model assertion.
 *
 * @category models
 * @since 0.4.0
 */
export interface CausalRuntimeAssertionContext<
  M extends AnyMachine,
  Model,
  Expected,
  Error,
  Output,
  Observed
> extends CausalRuntimeInspectionContext<M, Error, Output> {
  readonly model: Model
  readonly expected: Expected
  readonly actual: CausalRuntimeCommandActual<M, Error, Output, Observed>
}

/**
 * Configuration for causally checking runtime commands against a reference
 * model.
 *
 * @category models
 * @since 0.4.0
 */
export interface CausalRuntimeModelOptions<
  M extends AnyMachine,
  Model,
  Expected,
  Error,
  Output,
  Observed = never,
  ModelError = never,
  ModelServices = never,
  InspectionError = never,
  InspectionServices = never,
  AssertionError = never,
  AssertionServices = never
> {
  readonly initialModel: Model
  /** Live-clock bound for an explicit `RuntimeAwait.until`. Defaults to one second. */
  readonly observationTimeout?: Duration.Input
  readonly transition: (
    model: Model,
    command: RuntimeCommand<Machine.Machine.InputEvent<M>>,
    index: number
  ) => Effect.Effect<
    CausalRuntimeModelStep<
      Model,
      Expected,
      Machine.Machine.Snapshot<Machine.Machine.States<M>>,
      Error,
      Output
    >,
    ModelError,
    ModelServices
  >
  readonly inspect?: (
    context: CausalRuntimeInspectionContext<M, Error, Output>
  ) => Effect.Effect<Observed, InspectionError, InspectionServices>
  readonly assert: (
    context: CausalRuntimeAssertionContext<M, Model, Expected, Error, Output, Observed>
  ) => Effect.Effect<void, AssertionError, AssertionServices>
}

/**
 * Context used to select additional asynchronous observation for a law-oriented command run.
 *
 * @category models
 * @since 0.4.0
 */
export interface CausalVerificationAwaitContext<M extends AnyMachine, Error, Output> {
  readonly index: number
  readonly command: RuntimeCommand<Machine.Machine.InputEvent<M>>
  readonly probe: Probe<M, Error, Output>
}

/**
 * Configuration for causal verification without a separate reference model.
 *
 * @category models
 * @since 0.4.0
 */
export interface CausalVerificationOptions<M extends AnyMachine, Error, Output> {
  readonly invariants: ReadonlyArray<RuntimeInvariant<M>>
  readonly observationTimeout?: Duration.Input
  readonly await?: (
    context: CausalVerificationAwaitContext<M, Error, Output>
  ) => RuntimeAwait<Machine.Machine.Snapshot<Machine.Machine.States<M>>, Error, Output>
}

/**
 * A law-oriented causal transcript without dummy model or expected fields.
 *
 * @category models
 * @since 0.4.0
 */
export interface CausalVerificationTranscript<M extends AnyMachine, Error, Output>
  extends CausalRuntimeEvidence<M, Error, Output>
{}

/**
 * Actual evidence made available to a runtime command assertion.
 *
 * @category models
 * @since 0.4.0
 */
export interface RuntimeCommandActual<State, Error, Output, Observed> {
  readonly result: RuntimeCommandResult
  readonly snapshot: Machine.RuntimeSnapshot<State, Error, Output> | undefined
  readonly published: ReadonlyArray<Machine.RuntimeSnapshot<State, Error, Output>>
  readonly inspected: Observed | undefined
}

/**
 * Context supplied to a custom runtime inspection effect.
 *
 * @category models
 * @since 0.4.0
 */
export interface RuntimeInspectionContext<State, Event, Error, Output> {
  readonly index: number
  readonly command: RuntimeCommand<Event>
  readonly result: RuntimeCommandResult
  readonly ref: Machine.MachineRef<State, Event, Error, Output>
  readonly snapshot: Machine.RuntimeSnapshot<State, Error, Output> | undefined
  readonly published: ReadonlyArray<Machine.RuntimeSnapshot<State, Error, Output>>
}

/**
 * Context supplied to the reference-model assertion.
 *
 * @category models
 * @since 0.4.0
 */
export interface RuntimeAssertionContext<Model, Expected, State, Event, Error, Output, Observed>
  extends RuntimeInspectionContext<State, Event, Error, Output>
{
  readonly model: Model
  readonly expected: Expected
  readonly actual: RuntimeCommandActual<State, Error, Output, Observed>
}

/**
 * Configuration for an Effect-native runtime command-model run.
 *
 * @category models
 * @since 0.4.0
 */
export interface RuntimeModelOptions<
  Model,
  Expected,
  State,
  Event,
  Error,
  Output,
  Observed = never,
  ModelError = never,
  ModelServices = never,
  InspectionError = never,
  InspectionServices = never,
  AssertionError = never,
  AssertionServices = never
> {
  readonly initialModel: Model
  /**
   * Live-clock bound for `Next` and `Until` synchronization. Defaults to one
   * second and never advances the machine's virtual `TestClock`.
   */
  readonly observationTimeout?: Duration.Input
  readonly transition: (
    model: Model,
    command: RuntimeCommand<Event>,
    index: number
  ) => Effect.Effect<
    RuntimeModelStep<Model, Expected, State, Error, Output>,
    ModelError,
    ModelServices
  >
  readonly inspect?: (
    context: RuntimeInspectionContext<State, Event, Error, Output>
  ) => Effect.Effect<Observed, InspectionError, InspectionServices>
  readonly assert: (
    context: RuntimeAssertionContext<Model, Expected, State, Event, Error, Output, Observed>
  ) => Effect.Effect<void, AssertionError, AssertionServices>
}

/**
 * One successfully checked command in a replayable runtime transcript.
 *
 * @category models
 * @since 0.4.0
 */
export interface RuntimeCommandRecord<Model, Expected, State, Event, Error, Output, Observed> {
  readonly index: number
  readonly command: RuntimeCommand<Event>
  readonly model: Model
  readonly expected: Expected
  readonly actual: RuntimeCommandActual<State, Error, Output, Observed>
}

/**
 * A complete command-model execution transcript.
 *
 * @category models
 * @since 0.4.0
 */
export interface RuntimeTranscript<Model, Expected, State, Event, Error, Output, Observed> {
  readonly commands: ReadonlyArray<RuntimeCommand<Event>>
  readonly initial: Machine.RuntimeSnapshot<State, Error, Output>
  readonly records: ReadonlyArray<RuntimeCommandRecord<Model, Expected, State, Event, Error, Output, Observed>>
  readonly finalModel: Model
  /** The last explicitly synchronized snapshot, never a racy trailing sample. */
  readonly final: Machine.RuntimeSnapshot<State, Error, Output>
  /**
   * `false` when potentially outstanding work has not been bounded by an
   * `Until` predicate or a terminal snapshot.
   */
  readonly synchronized: boolean
}

/**
 * Enqueue-oriented name for actual runtime command evidence.
 *
 * @category models
 * @since 0.4.0
 */
export type EnqueuedRuntimeCommandActual<State, Error, Output, Observed> = RuntimeCommandActual<
  State,
  Error,
  Output,
  Observed
>

/**
 * Enqueue-oriented name for runtime inspection context.
 *
 * @category models
 * @since 0.4.0
 */
export type EnqueuedRuntimeInspectionContext<State, Event, Error, Output> = RuntimeInspectionContext<
  State,
  Event,
  Error,
  Output
>

/**
 * Enqueue-oriented name for runtime assertion context.
 *
 * @category models
 * @since 0.4.0
 */
export type EnqueuedRuntimeAssertionContext<Model, Expected, State, Event, Error, Output, Observed> =
  RuntimeAssertionContext<Model, Expected, State, Event, Error, Output, Observed>

/**
 * Enqueue-oriented options for a runtime reference model.
 *
 * @category models
 * @since 0.4.0
 */
export type EnqueuedRuntimeModelOptions<
  Model,
  Expected,
  State,
  Event,
  Error,
  Output,
  Observed = never,
  ModelError = never,
  ModelServices = never,
  InspectionError = never,
  InspectionServices = never,
  AssertionError = never,
  AssertionServices = never
> = RuntimeModelOptions<
  Model,
  Expected,
  State,
  Event,
  Error,
  Output,
  Observed,
  ModelError,
  ModelServices,
  InspectionError,
  InspectionServices,
  AssertionError,
  AssertionServices
>

/**
 * Enqueue-oriented name for a checked runtime command record.
 *
 * @category models
 * @since 0.4.0
 */
export type EnqueuedRuntimeCommandRecord<Model, Expected, State, Event, Error, Output, Observed> = RuntimeCommandRecord<
  Model,
  Expected,
  State,
  Event,
  Error,
  Output,
  Observed
>

/**
 * Enqueue-oriented name for a complete runtime transcript.
 *
 * @category models
 * @since 0.4.0
 */
export type EnqueuedRuntimeTranscript<Model, Expected, State, Event, Error, Output, Observed> = RuntimeTranscript<
  Model,
  Expected,
  State,
  Event,
  Error,
  Output,
  Observed
>

/**
 * One successfully checked causal command.
 *
 * @category models
 * @since 0.4.0
 */
export interface CausalRuntimeCommandRecord<
  M extends AnyMachine,
  Model,
  Expected,
  Error,
  Output,
  Observed
> {
  readonly index: number
  readonly command: RuntimeCommand<Machine.Machine.InputEvent<M>>
  readonly model: Model
  readonly expected: Expected
  readonly actual: CausalRuntimeCommandActual<M, Error, Output, Observed>
}

/**
 * A complete causally executed command-model transcript.
 *
 * Every accepted send in `records` completed its managed macrostep. This does
 * not claim that later timer, invoke, or child work has completed unless the
 * corresponding model step requested `probe.await.until`.
 *
 * @category models
 * @since 0.4.0
 */
export interface CausalRuntimeTranscript<
  M extends AnyMachine,
  Model,
  Expected,
  Error,
  Output,
  Observed
> {
  readonly commands: ReadonlyArray<RuntimeCommand<Machine.Machine.InputEvent<M>>>
  readonly initial: Machine.RuntimeSnapshot<Machine.Machine.Snapshot<Machine.Machine.States<M>>, Error, Output>
  readonly records: ReadonlyArray<CausalRuntimeCommandRecord<M, Model, Expected, Error, Output, Observed>>
  readonly finalModel: Model
  readonly final: Machine.RuntimeSnapshot<Machine.Machine.Snapshot<Machine.Machine.States<M>>, Error, Output>
}

/**
 * Partial evidence retained when a causal command fails after execution has
 * begun but before a complete checked record exists.
 *
 * @category models
 * @since 0.4.0
 */
export interface CausalRuntimeCommandAttempt<
  M extends AnyMachine,
  Model,
  Expected,
  Error,
  Output,
  Observed
> {
  readonly index: number
  readonly command: RuntimeCommand<Machine.Machine.InputEvent<M>>
  readonly model: Model
  readonly expected: Expected
  readonly result: CausalRuntimeCommandResult<M> | undefined
  readonly snapshot:
    | Machine.RuntimeSnapshot<Machine.Machine.Snapshot<Machine.Machine.States<M>>, Error, Output>
    | undefined
  readonly awaited: ReadonlyArray<
    Machine.RuntimeSnapshot<Machine.Machine.Snapshot<Machine.Machine.States<M>>, Error, Output>
  >
  readonly inspected: Observed | undefined
}

/**
 * Failure raised when an expected public change stream observation is absent.
 *
 * @category errors
 * @since 0.4.0
 */
export class RuntimeObservationError extends Data.TaggedError("MachineTestRuntimeObservationError")<{
  readonly index: number
  readonly synchronization: "Next" | "Until"
  readonly reason: "ended" | "timeout"
  readonly message: string
}> {}

/**
 * A typed command-model failure retaining the successfully checked prefix.
 *
 * @category errors
 * @since 0.4.0
 */
export class RuntimeCommandFailure<
  Failure = unknown,
  Model = unknown,
  Expected = unknown,
  State = unknown,
  Event = unknown,
  Error = unknown,
  Output = unknown,
  Observed = unknown
> extends Data.TaggedError("MachineTestRuntimeCommandFailure")<{
  readonly phase: "model" | "execution" | "observation" | "inspection" | "assertion"
  readonly index: number
  readonly command: RuntimeCommand<Event>
  readonly cause: Cause.Cause<Failure>
  readonly prefix: ReadonlyArray<RuntimeCommandRecord<Model, Expected, State, Event, Error, Output, Observed>>
  readonly attempted: RuntimeCommandRecord<Model, Expected, State, Event, Error, Output, Observed> | undefined
}> {}

/**
 * A typed causal command-model failure retaining the successfully checked
 * prefix and exact attempted command.
 *
 * @category errors
 * @since 0.4.0
 */
export class CausalRuntimeCommandFailure<
  Failure = unknown,
  M extends AnyMachine = AnyMachine,
  Model = unknown,
  Expected = unknown,
  Error = unknown,
  Output = unknown,
  Observed = unknown
> extends Data.TaggedError("MachineTestCausalRuntimeCommandFailure")<{
  readonly phase: "model" | "execution" | "observation" | "inspection" | "assertion"
  readonly index: number
  readonly command: RuntimeCommand<Machine.Machine.InputEvent<M>>
  readonly cause: Cause.Cause<Failure>
  readonly prefix: ReadonlyArray<CausalRuntimeCommandRecord<M, Model, Expected, Error, Output, Observed>>
  readonly attempted: CausalRuntimeCommandAttempt<M, Model, Expected, Error, Output, Observed> | undefined
}> {}

type ChangeEntry<State, Error, Output> =
  | { readonly _tag: "Snapshot"; readonly snapshot: Machine.RuntimeSnapshot<State, Error, Output> }
  | { readonly _tag: "End" }

const makeFailure = <Failure, Model, Expected, State, Event, Error, Output, Observed>(options: {
  readonly phase: "model" | "execution" | "observation" | "inspection" | "assertion"
  readonly index: number
  readonly command: RuntimeCommand<Event>
  readonly cause: Cause.Cause<Failure>
  readonly prefix: ReadonlyArray<RuntimeCommandRecord<Model, Expected, State, Event, Error, Output, Observed>>
  readonly attempted?: RuntimeCommandRecord<Model, Expected, State, Event, Error, Output, Observed>
}): RuntimeCommandFailure<Failure, Model, Expected, State, Event, Error, Output, Observed> =>
  new RuntimeCommandFailure({
    ...options,
    prefix: options.prefix.slice(),
    attempted: options.attempted
  })

const executeCommand = <State, Event, Error, Output>(
  ref: Machine.MachineRef<State, Event, Error, Output>,
  command: RuntimeCommand<Event>
): Effect.Effect<RuntimeCommandResult> => {
  switch (command._tag) {
    case "Send":
      return ref.send(command.event).pipe(
        Effect.match({
          onFailure: (error): RuntimeCommandResult => ({ _tag: "SendRejected", error }),
          onSuccess: (): RuntimeCommandResult => ({ _tag: "SendAccepted" })
        })
      )
    case "Advance":
      return TestClock.adjust(command.duration).pipe(Effect.as({ _tag: "ClockAdvanced" } as const))
    case "Stop":
      return ref.stop.pipe(Effect.as({ _tag: "Stopped" } as const))
    case "Checkpoint":
      return Effect.succeed({ _tag: "Checkpoint" } as const)
  }
}

const synchronize = <State, Event, Error, Output>(
  ref: Machine.MachineRef<State, Event, Error, Output>,
  queue: Queue.Dequeue<ChangeEntry<State, Error, Output>>,
  policy: RuntimeSynchronization<State, Error, Output>,
  index: number,
  timeout: Duration.Input
): Effect.Effect<{
  readonly snapshot: Machine.RuntimeSnapshot<State, Error, Output> | undefined
  readonly published: ReadonlyArray<Machine.RuntimeSnapshot<State, Error, Output>>
}, RuntimeObservationError> => {
  const wait = <A>(
    synchronization: "Next" | "Until",
    effect: Effect.Effect<A, RuntimeObservationError>
  ): Effect.Effect<A, RuntimeObservationError> =>
    TestClock.withLive(effect.pipe(Effect.timeout(timeout))).pipe(
      Effect.mapError((cause) =>
        cause instanceof RuntimeObservationError
          ? cause
          : new RuntimeObservationError({
            index,
            synchronization,
            reason: "timeout",
            message: `timed out after ${Duration.toMillis(timeout)}ms waiting for the expected published snapshot`
          })
      )
    )
  switch (policy._tag) {
    case "None":
      return Effect.succeed({ snapshot: undefined, published: [] })
    case "Current":
      return ref.snapshot.pipe(Effect.map((snapshot) => ({ snapshot, published: [] })))
    case "Next":
      return wait(
        "Next",
        Queue.take(queue).pipe(
          Effect.flatMap((entry) =>
            entry._tag === "Snapshot"
              ? Effect.succeed({ snapshot: entry.snapshot, published: [entry.snapshot] })
              : Effect.fail(
                new RuntimeObservationError({
                  index,
                  synchronization: "Next",
                  reason: "ended",
                  message: "the machine changes stream ended before publishing the expected snapshot"
                })
              )
          )
        )
      )
    case "Until":
      return wait(
        "Until",
        Effect.gen(function*() {
          const published: Array<Machine.RuntimeSnapshot<State, Error, Output>> = []
          while (true) {
            const entry = yield* Queue.take(queue)
            if (entry._tag === "End") {
              return yield* Effect.fail(
                new RuntimeObservationError({
                  index,
                  synchronization: "Until",
                  reason: "ended",
                  message: "the machine changes stream ended before a published snapshot matched the predicate"
                })
              )
            }
            published.push(entry.snapshot)
            if (policy.predicate(entry.snapshot)) {
              return { snapshot: entry.snapshot, published }
            }
          }
        })
      )
  }
}

const executeCausalCommand = <M extends AnyMachine, Error, Output>(
  probe: Probe<M, Error, Output>,
  command: RuntimeCommand<Machine.Machine.InputEvent<M>>
): Effect.Effect<CausalRuntimeCommandResult<M>, Error> => {
  switch (command._tag) {
    case "Send":
      return Effect.matchEffect(probe.sendAndAwait(command.event), {
        onFailure: (error) =>
          error instanceof Machine.StoppedError
            ? probe.ref.snapshot.pipe(
              Effect.flatMap((snapshot) =>
                snapshot.status === "stopped"
                  ? Effect.succeed({ _tag: "SendRejected", error } as const)
                  : Effect.fail(error as Error)
              )
            )
            : Effect.fail(error as Error),
        onSuccess: (step) => Effect.succeed({ _tag: "SendProcessed", step } as const)
      })
    case "Advance":
      return TestClock.adjust(command.duration).pipe(Effect.as({ _tag: "ClockAdvanced" } as const))
    case "Stop":
      return probe.ref.stop.pipe(Effect.as({ _tag: "Stopped" } as const))
    case "Checkpoint":
      return Effect.succeed({ _tag: "Checkpoint" } as const)
  }
}

const awaitCausal = <State, Event, Error, Output>(
  ref: Machine.MachineRef<State, Event, Error, Output>,
  policy: RuntimeAwait<State, Error, Output>,
  index: number,
  timeout: Duration.Input
): Effect.Effect<{
  readonly snapshot: Machine.RuntimeSnapshot<State, Error, Output>
  readonly awaited: ReadonlyArray<Machine.RuntimeSnapshot<State, Error, Output>>
}, RuntimeObservationError> => {
  if (policy._tag === "None") {
    return ref.snapshot.pipe(Effect.map((snapshot) => ({ snapshot, awaited: [] })))
  }

  const observation = Effect.scoped(
    Effect.gen(function*() {
      const changes = yield* Queue.unbounded<ChangeEntry<State, Error, Output>>()
      yield* ref.changes.pipe(
        Stream.runForEach((snapshot) => Queue.offer(changes, { _tag: "Snapshot", snapshot })),
        Effect.ensuring(Queue.offer(changes, { _tag: "End" })),
        Effect.forkScoped({ startImmediately: true })
      )
      const awaited: Array<Machine.RuntimeSnapshot<State, Error, Output>> = []
      while (true) {
        const entry = yield* Queue.take(changes)
        if (entry._tag === "End") {
          return yield* Effect.fail(
            new RuntimeObservationError({
              index,
              synchronization: "Until",
              reason: "ended",
              message: "the machine changes stream ended before an awaited snapshot matched the predicate"
            })
          )
        }
        awaited.push(entry.snapshot)
        if (policy.predicate(entry.snapshot)) return { snapshot: entry.snapshot, awaited }
      }
    })
  )

  return TestClock.withLive(observation.pipe(Effect.timeout(timeout))).pipe(
    Effect.mapError((cause) =>
      cause instanceof RuntimeObservationError
        ? cause
        : new RuntimeObservationError({
          index,
          synchronization: "Until",
          reason: "timeout",
          message: `timed out after ${Duration.toMillis(timeout)}ms waiting for an awaited runtime snapshot`
        })
    )
  )
}

/**
 * Runs typed commands against a live `MachineRef` and checks them against a
 * supplied Effect-native reference model.
 *
 * The runner observes only public `MachineRef` behavior. In particular, a
 * successful send means enqueue acceptance, not completed processing. A model
 * must request `Next`/`Until` only when it predicts a publication, or use an
 * explicit checkpoint to drain previously enqueued work. Machine emissions can
 * be captured by the runtime service used by the machine and returned from the
 * optional `inspect` effect.
 *
 * Typed failures and defects from model transitions, command execution,
 * inspection, and assertions are retained as full `Cause` values. A cause
 * containing only interruption is propagated as interruption so cancelling a
 * property run cannot be mistaken for a machine counterexample.
 *
 * @category constructors
 * @since 0.4.0
 */
export const runEnqueuedCommands = <
  Model,
  Expected,
  State,
  Event,
  Error,
  Output,
  Observed = never,
  ModelError = never,
  ModelServices = never,
  InspectionError = never,
  InspectionServices = never,
  AssertionError = never,
  AssertionServices = never
>(
  ref: Machine.MachineRef<State, Event, Error, Output>,
  commands: Iterable<RuntimeCommand<Event>>,
  options: RuntimeModelOptions<
    Model,
    Expected,
    State,
    Event,
    Error,
    Output,
    Observed,
    ModelError,
    ModelServices,
    InspectionError,
    InspectionServices,
    AssertionError,
    AssertionServices
  >
): Effect.Effect<
  RuntimeTranscript<Model, Expected, State, Event, Error, Output, Observed>,
  RuntimeCommandFailure<
    ModelError | InspectionError | AssertionError | RuntimeObservationError,
    Model,
    Expected,
    State,
    Event,
    Error,
    Output,
    Observed
  >,
  ModelServices | InspectionServices | AssertionServices
> =>
  Effect.scoped(
    Effect.gen(function*() {
      const sequence = Array.from(commands)
      const observationTimeout = options.observationTimeout ?? "1 second"
      const observationTimeoutMillis = Duration.toMillis(observationTimeout)
      if (!Number.isFinite(observationTimeoutMillis) || observationTimeoutMillis < 0) {
        return yield* Effect.die(
          new Error("MachineTest.runEnqueuedCommands expected observationTimeout to be a finite non-negative duration")
        )
      }
      const changes = yield* Queue.unbounded<ChangeEntry<State, Error, Output>>()
      const ready = yield* Deferred.make<void>()
      yield* ref.changes.pipe(
        Stream.runForEach((snapshot) =>
          Queue.offer(changes, { _tag: "Snapshot", snapshot }).pipe(
            Effect.andThen(Deferred.succeed(ready, undefined)),
            Effect.asVoid
          )
        ),
        Effect.ensuring(
          Deferred.succeed(ready, undefined).pipe(
            Effect.andThen(Queue.offer(changes, { _tag: "End" })),
            Effect.asVoid
          )
        ),
        Effect.forkScoped({ startImmediately: true })
      )
      yield* Deferred.await(ready)
      const initialEntry = yield* Queue.take(changes)
      const initial = initialEntry._tag === "Snapshot" ? initialEntry.snapshot : yield* ref.snapshot
      const records: Array<RuntimeCommandRecord<Model, Expected, State, Event, Error, Output, Observed>> = []
      let model = options.initialModel
      let lastSynchronized = initial
      let outstandingWorkUnknown = false

      const capture = <A, Failure, R>(options: {
        readonly phase: "model" | "observation" | "inspection" | "assertion" | "execution"
        readonly index: number
        readonly command: RuntimeCommand<Event>
        readonly effect: () => Effect.Effect<A, Failure, R>
        readonly attempted?: RuntimeCommandRecord<Model, Expected, State, Event, Error, Output, Observed>
      }): Effect.Effect<
        A,
        RuntimeCommandFailure<Failure, Model, Expected, State, Event, Error, Output, Observed>,
        R
      > =>
        Effect.catchCause(Effect.suspend(options.effect), (cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause as Cause.Cause<never>)
            : Effect.fail(
              makeFailure<Failure, Model, Expected, State, Event, Error, Output, Observed>({
                phase: options.phase,
                index: options.index,
                command: options.command,
                cause,
                prefix: records,
                ...(options.attempted === undefined ? {} : { attempted: options.attempted })
              })
            ))

      for (let index = 0; index < sequence.length; index++) {
        const command = sequence[index]!
        const step = yield* capture({
          phase: "model",
          index,
          command,
          effect: () => options.transition(model, command, index)
        })
        model = step.model
        const result = yield* capture({
          phase: "execution",
          index,
          command,
          effect: () => executeCommand(ref, command)
        })
        const attemptedBeforeObservation: RuntimeCommandRecord<
          Model,
          Expected,
          State,
          Event,
          Error,
          Output,
          Observed
        > = {
          index,
          command,
          model,
          expected: step.expected,
          actual: {
            result,
            snapshot: undefined,
            published: [],
            inspected: undefined
          }
        }
        const synchronized = yield* capture({
          phase: "observation",
          index,
          command,
          effect: () => synchronize(ref, changes, step.synchronize, index, observationTimeout),
          attempted: attemptedBeforeObservation
        })
        const terminal = synchronized.snapshot !== undefined && synchronized.snapshot.status !== "active"
        const previouslyOutstanding: boolean = outstandingWorkUnknown
        switch (step.synchronize._tag) {
          case "None":
            if (
              command._tag === "Advance" || command._tag === "Stop" ||
              (command._tag === "Send" && result._tag === "SendAccepted")
            ) outstandingWorkUnknown = true
            break
          case "Next":
            if (synchronized.snapshot !== undefined) lastSynchronized = synchronized.snapshot
            outstandingWorkUnknown = terminal
              ? false
              : previouslyOutstanding || command._tag === "Advance" ||
                (command._tag === "Send" && result._tag === "SendAccepted")
            break
          case "Until":
            if (synchronized.snapshot !== undefined) lastSynchronized = synchronized.snapshot
            outstandingWorkUnknown = false
            break
          case "Current":
            if (terminal) outstandingWorkUnknown = false
            if (!outstandingWorkUnknown && synchronized.snapshot !== undefined) lastSynchronized = synchronized.snapshot
            break
        }
        const inspectionContext: RuntimeInspectionContext<State, Event, Error, Output> = {
          index,
          command,
          result,
          ref,
          snapshot: synchronized.snapshot,
          published: synchronized.published
        }
        const attemptedBeforeInspection: RuntimeCommandRecord<
          Model,
          Expected,
          State,
          Event,
          Error,
          Output,
          Observed
        > = {
          ...attemptedBeforeObservation,
          actual: {
            result,
            snapshot: synchronized.snapshot,
            published: synchronized.published,
            inspected: undefined
          }
        }
        const inspected = options.inspect === undefined
          ? undefined
          : yield* capture({
            phase: "inspection",
            index,
            command,
            effect: () => options.inspect!(inspectionContext),
            attempted: attemptedBeforeInspection
          })
        const actual: RuntimeCommandActual<State, Error, Output, Observed> = {
          result,
          snapshot: synchronized.snapshot,
          published: synchronized.published,
          inspected
        }
        const record: RuntimeCommandRecord<Model, Expected, State, Event, Error, Output, Observed> = {
          index,
          command,
          model,
          expected: step.expected,
          actual
        }
        yield* capture({
          phase: "assertion",
          index,
          command,
          effect: () =>
            options.assert({
              ...inspectionContext,
              model,
              expected: step.expected,
              actual
            }),
          attempted: record
        })
        records.push(record)
      }

      return {
        commands: sequence,
        initial,
        records,
        finalModel: model,
        final: lastSynchronized,
        synchronized: !outstandingWorkUnknown
      }
    })
  )

/**
 * Compatibility alias for enqueue-oriented runtime command execution.
 *
 * @deprecated Use `runEnqueuedCommands`. This compatibility name does not
 * expose whether sends are merely enqueued or causally processed.
 *
 * @category constructors
 * @since 0.4.0
 */
export const runRuntimeCommands: typeof runEnqueuedCommands = runEnqueuedCommands

/**
 * Runs typed commands against a probe and checks them against an Effect-native
 * reference model.
 *
 * Every accepted `Send` completes its exact managed runtime macrostep before
 * inspection, assertion, and the next command. Use `probe.await.until` only
 * for later asynchronous work such as timer, invoke, or child delivery.
 * Processing failures are attributed to the exact submitted command and retain
 * the successfully checked prefix for FastCheck shrinking and replay.
 *
 * Use `runEnqueuedCommands` instead when the behavior under test intentionally
 * depends on burst enqueueing or outstanding mailbox work.
 *
 * @category constructors
 * @since 0.4.0
 */
export const runCausalCommands = <
  M extends AnyMachine,
  Error,
  Output,
  Model,
  Expected,
  Observed = never,
  ModelError = never,
  ModelServices = never,
  InspectionError = never,
  InspectionServices = never,
  AssertionError = never,
  AssertionServices = never
>(
  probe: Probe<M, Error, Output>,
  commands: Iterable<RuntimeCommand<Machine.Machine.InputEvent<M>>>,
  options: CausalRuntimeModelOptions<
    M,
    Model,
    Expected,
    Error,
    Output,
    Observed,
    ModelError,
    ModelServices,
    InspectionError,
    InspectionServices,
    AssertionError,
    AssertionServices
  >
): Effect.Effect<
  CausalRuntimeTranscript<M, Model, Expected, Error, Output, Observed>,
  CausalRuntimeCommandFailure<
    Error | ModelError | InspectionError | AssertionError | RuntimeObservationError,
    M,
    Model,
    Expected,
    Error,
    Output,
    Observed
  >,
  ModelServices | InspectionServices | AssertionServices
> =>
  Effect.gen(function*() {
    const sequence = Array.from(commands)
    const observationTimeout = options.observationTimeout ?? "1 second"
    const observationTimeoutMillis = Duration.toMillis(observationTimeout)
    if (!Number.isFinite(observationTimeoutMillis) || observationTimeoutMillis < 0) {
      return yield* Effect.die(
        new Error("MachineTest.runCausalCommands expected observationTimeout to be a finite non-negative duration")
      )
    }

    const initial = yield* probe.ref.snapshot
    const records: Array<CausalRuntimeCommandRecord<M, Model, Expected, Error, Output, Observed>> = []
    let model = options.initialModel
    let final = initial

    const capture = <A, Failure, R>(captureOptions: {
      readonly phase: "model" | "observation" | "inspection" | "assertion" | "execution"
      readonly index: number
      readonly command: RuntimeCommand<Machine.Machine.InputEvent<M>>
      readonly effect: () => Effect.Effect<A, Failure, R>
      readonly attempted?: CausalRuntimeCommandAttempt<M, Model, Expected, Error, Output, Observed>
    }): Effect.Effect<
      A,
      CausalRuntimeCommandFailure<Failure, M, Model, Expected, Error, Output, Observed>,
      R
    > =>
      Effect.catchCause(Effect.suspend(captureOptions.effect), (cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause as Cause.Cause<never>)
          : Effect.fail(
            new CausalRuntimeCommandFailure({
              phase: captureOptions.phase,
              index: captureOptions.index,
              command: captureOptions.command,
              cause,
              prefix: records.slice(),
              attempted: captureOptions.attempted
            })
          ))

    for (let index = 0; index < sequence.length; index++) {
      const command = sequence[index]!
      const step = yield* capture({
        phase: "model",
        index,
        command,
        effect: () => options.transition(model, command, index)
      })
      model = step.model

      const attemptedBeforeExecution: CausalRuntimeCommandAttempt<
        M,
        Model,
        Expected,
        Error,
        Output,
        Observed
      > = {
        index,
        command,
        model,
        expected: step.expected,
        result: undefined,
        snapshot: undefined,
        awaited: [],
        inspected: undefined
      }
      const result = yield* capture({
        phase: "execution",
        index,
        command,
        effect: () => executeCausalCommand(probe, command),
        attempted: attemptedBeforeExecution
      })
      const attemptedAfterExecution: CausalRuntimeCommandAttempt<
        M,
        Model,
        Expected,
        Error,
        Output,
        Observed
      > = {
        ...attemptedBeforeExecution,
        result
      }

      const observation = yield* capture({
        phase: "observation",
        index,
        command,
        effect: () => awaitCausal(probe.ref, step.await ?? { _tag: "None" }, index, observationTimeout),
        attempted: attemptedAfterExecution
      })
      final = observation.snapshot
      const inspectionContext: CausalRuntimeInspectionContext<M, Error, Output> = {
        index,
        command,
        result,
        probe,
        ref: probe.ref,
        snapshot: observation.snapshot,
        awaited: observation.awaited
      }
      const attemptedAfterObservation: CausalRuntimeCommandAttempt<
        M,
        Model,
        Expected,
        Error,
        Output,
        Observed
      > = {
        ...attemptedAfterExecution,
        snapshot: observation.snapshot,
        awaited: observation.awaited
      }
      const inspected = options.inspect === undefined
        ? undefined
        : yield* capture({
          phase: "inspection",
          index,
          command,
          effect: () => options.inspect!(inspectionContext),
          attempted: attemptedAfterObservation
        })
      const actual: CausalRuntimeCommandActual<M, Error, Output, Observed> = {
        result,
        snapshot: observation.snapshot,
        awaited: observation.awaited,
        inspected
      }
      const record: CausalRuntimeCommandRecord<M, Model, Expected, Error, Output, Observed> = {
        index,
        command,
        model,
        expected: step.expected,
        actual
      }
      yield* capture({
        phase: "assertion",
        index,
        command,
        effect: () =>
          options.assert({
            ...inspectionContext,
            model,
            expected: step.expected,
            actual
          }),
        attempted: {
          ...attemptedAfterObservation,
          inspected
        }
      })
      records.push(record)
    }

    return {
      commands: sequence,
      initial,
      records,
      finalModel: model,
      final
    }
  })

/**
 * Causally executes commands and checks reusable runtime invariants without
 * requiring a dummy reference model. Use `runCausalCommands` when exact
 * expected results come from an application model.
 *
 * @category constructors
 * @since 0.4.0
 */
export const verifyCausalCommands = <M extends AnyMachine, Error, Output>(
  probe: Probe<M, Error, Output>,
  commands: Iterable<RuntimeCommand<Machine.Machine.InputEvent<M>>>,
  options: CausalVerificationOptions<M, Error, Output>
): Effect.Effect<
  CausalVerificationTranscript<M, Error, Output>,
  | CausalRuntimeCommandFailure<
    Error | RuntimeObservationError,
    M,
    undefined,
    undefined,
    Error,
    Output,
    never
  >
  | RuntimeInvariantError<M>
> =>
  Effect.gen(function*() {
    const transcript = yield* runCausalCommands(probe, commands, {
      initialModel: undefined,
      ...(options.observationTimeout === undefined ? {} : { observationTimeout: options.observationTimeout }),
      transition: (_model, command, index) =>
        Effect.sync(() => ({
          model: undefined,
          expected: undefined,
          ...(options.await === undefined ? {} : { await: options.await({ index, command, probe }) })
        })),
      assert: () => Effect.void
    })
    const evidence: CausalVerificationTranscript<M, Error, Output> = {
      commands: transcript.commands,
      initial: transcript.initial,
      records: transcript.records.map(({ actual, command, index }) => ({ index, command, actual })),
      final: transcript.final
    }
    yield* assertRuntimeInvariants(probe.machine, evidence, options.invariants)
    return evidence
  })

/**
 * Options controlling schema-derived runtime command generation.
 *
 * @category models
 * @since 0.4.0
 */
export interface RuntimeCommandsOptions<M extends AnyMachine> {
  readonly minCommands?: number
  readonly maxCommands?: number
  readonly eventArbitrary?: FastCheck.Arbitrary<Machine.Machine.InputEvent<M>>
  readonly advanceArbitrary?: FastCheck.Arbitrary<Duration.Input>
  readonly includeAdvance?: boolean
  readonly includeStop?: boolean
  readonly includeCheckpoint?: boolean
  readonly additionalCommands?: ReadonlyArray<FastCheck.Arbitrary<RuntimeCommand<Machine.Machine.InputEvent<M>>>>
}

/**
 * Diagnostics describing a schema-derived runtime command arbitrary.
 *
 * @category models
 * @since 0.4.0
 */
export interface RuntimeCommandsDiagnostics {
  readonly events: "none" | "schema" | "override"
  readonly schemaReports: ReadonlyArray<SchemaArbitraryReport>
  readonly includesAdvance: boolean
  readonly includesStop: boolean
  readonly includesCheckpoint: boolean
}

/**
 * A shrinkable runtime command arbitrary and its derivation diagnostics.
 *
 * @category models
 * @since 0.4.0
 */
export interface RuntimeCommands<M extends AnyMachine> {
  readonly arbitrary: FastCheck.Arbitrary<ReadonlyArray<RuntimeCommand<Machine.Machine.InputEvent<M>>>>
  readonly diagnostics: RuntimeCommandsDiagnostics
}

const validateCommandLength = (name: "minCommands" | "maxCommands", value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`MachineTest.runtimeCommands expected ${name} to be a non-negative safe integer`)
  }
}

/**
 * Derives a shrinkable command sequence from public event schemas and explicit
 * clock/stop/checkpoint command choices.
 *
 * This deliberately returns ordinary Effect FastCheck arbitraries instead of
 * adapting the runner through `asyncModelRun`: the latter requires Promise
 * callbacks and would erase Effect error and service channels.
 *
 * @category constructors
 * @since 0.4.0
 */
export const runtimeCommands = <M extends AnyMachine>(
  machine: M,
  options: RuntimeCommandsOptions<M> = {}
): RuntimeCommands<M> => {
  const minCommands = options.minCommands ?? 0
  const maxCommands = options.maxCommands ?? 50
  validateCommandLength("minCommands", minCommands)
  validateCommandLength("maxCommands", maxCommands)
  if (minCommands > maxCommands) {
    throw new Error("MachineTest.runtimeCommands expected minCommands to be less than or equal to maxCommands")
  }

  const reports: Array<SchemaArbitraryReport> = []
  const eventArbitraries = options.eventArbitrary === undefined
    ? machine.events.map((schema) => {
      const derived = toArbitraryWithReport(schema)
      reports.push(derived.report)
      return derived.value as FastCheck.Arbitrary<Machine.Machine.InputEvent<M>>
    })
    : []
  const eventArbitrary = options.eventArbitrary ?? (eventArbitraries.length === 0
    ? undefined
    : FastCheck.oneof(
      ...eventArbitraries as [
        FastCheck.Arbitrary<Machine.Machine.InputEvent<M>>,
        ...Array<FastCheck.Arbitrary<Machine.Machine.InputEvent<M>>>
      ]
    ))
  const commandArbitraries: Array<FastCheck.Arbitrary<RuntimeCommand<Machine.Machine.InputEvent<M>>>> = []
  if (eventArbitrary !== undefined) commandArbitraries.push(eventArbitrary.map(sendCommand))

  if (options.includeAdvance !== false) {
    const advanceArbitrary = options.advanceArbitrary ?? FastCheck.nat({ max: 60_000 })
    commandArbitraries.push(advanceArbitrary.map(advanceCommand))
  }
  if (options.includeStop !== false) commandArbitraries.push(FastCheck.constant(stopCommand()))
  if (options.includeCheckpoint !== false) commandArbitraries.push(FastCheck.constant(checkpointCommand()))
  commandArbitraries.push(...options.additionalCommands ?? [])
  if (commandArbitraries.length === 0) {
    if (minCommands > 0) {
      throw new Error("MachineTest.runtimeCommands cannot generate a non-empty command sequence without commands")
    }
    return {
      arbitrary: FastCheck.constant([]),
      diagnostics: {
        events: options.eventArbitrary !== undefined ? "override" : eventArbitraries.length === 0 ? "none" : "schema",
        schemaReports: reports,
        includesAdvance: false,
        includesStop: false,
        includesCheckpoint: false
      }
    }
  }

  return {
    arbitrary: FastCheck.array(FastCheck.oneof(...commandArbitraries), {
      minLength: minCommands,
      maxLength: maxCommands
    }),
    diagnostics: {
      events: options.eventArbitrary !== undefined ? "override" : eventArbitraries.length === 0 ? "none" : "schema",
      schemaReports: reports,
      includesAdvance: options.includeAdvance !== false,
      includesStop: options.includeStop !== false,
      includesCheckpoint: options.includeCheckpoint !== false
    }
  }
}

/**
 * Formats a runtime transcript or failure as replayable line-oriented evidence.
 *
 * @category formatting
 * @since 0.4.0
 */
export const formatEnqueuedTranscript = (
  value:
    | RuntimeTranscript<any, any, any, any, any, any, any>
    | RuntimeCommandFailure<any, any, any, any, any, any, any, any>
): string => {
  const failure = value instanceof RuntimeCommandFailure
  const records = failure ? value.prefix : value.records
  const lines = [
    `commands: ${
      Inspectable.toStringUnknown(
        failure ?
          [
            ...value.prefix.map((record) => record.command),
            value.command
          ] :
          value.commands,
        0
      )
    }`
  ]
  for (const record of records) {
    lines.push(
      `command ${record.index}: command=${Inspectable.toStringUnknown(record.command, 0)} ` +
        `model=${Inspectable.toStringUnknown(record.model, 0)} ` +
        `expected=${Inspectable.toStringUnknown(record.expected, 0)} ` +
        `result=${Inspectable.toStringUnknown(record.actual.result, 0)} ` +
        `snapshot=${Inspectable.toStringUnknown(record.actual.snapshot, 0)} ` +
        `published=${Inspectable.toStringUnknown(record.actual.published, 0)} ` +
        `inspected=${Inspectable.toStringUnknown(record.actual.inspected, 0)}`
    )
  }
  if (failure) {
    if (value.attempted !== undefined) {
      lines.push(
        `attempted ${value.attempted.index}: command=${Inspectable.toStringUnknown(value.attempted.command, 0)} ` +
          `model=${Inspectable.toStringUnknown(value.attempted.model, 0)} ` +
          `expected=${Inspectable.toStringUnknown(value.attempted.expected, 0)} ` +
          `result=${Inspectable.toStringUnknown(value.attempted.actual.result, 0)} ` +
          `snapshot=${Inspectable.toStringUnknown(value.attempted.actual.snapshot, 0)} ` +
          `published=${Inspectable.toStringUnknown(value.attempted.actual.published, 0)} ` +
          `inspected=${Inspectable.toStringUnknown(value.attempted.actual.inspected, 0)}`
      )
    }
    lines.push(
      `failure: phase=${value.phase} index=${value.index} command=${Inspectable.toStringUnknown(value.command, 0)} ` +
        `cause=${Inspectable.toStringUnknown(value.cause, 0)}`
    )
  } else {
    lines.push(
      `final: synchronized=${String(value.synchronized)} snapshot=${Inspectable.toStringUnknown(value.final, 0)}`
    )
  }
  return lines.join("\n")
}

/**
 * Compatibility alias for enqueue-oriented transcript formatting.
 *
 * @deprecated Use `formatEnqueuedTranscript`.
 *
 * @category formatting
 * @since 0.4.0
 */
export const formatRuntimeTranscript: typeof formatEnqueuedTranscript = formatEnqueuedTranscript

/**
 * Formats a causal runtime transcript or failure as replayable line-oriented
 * evidence, including exact probe steps and explicit asynchronous observations.
 *
 * @category formatting
 * @since 0.4.0
 */
export const formatCausalTranscript = (
  value:
    | CausalRuntimeTranscript<any, any, any, any, any, any>
    | CausalRuntimeCommandFailure<any, any, any, any, any, any, any>
): string => {
  const failure = value instanceof CausalRuntimeCommandFailure
  const records = failure ? value.prefix : value.records
  const lines = [
    `commands: ${
      Inspectable.toStringUnknown(
        failure
          ? [
            ...value.prefix.map((record) => record.command),
            value.command
          ]
          : value.commands,
        0
      )
    }`
  ]
  for (const record of records) {
    lines.push(
      `command ${record.index}: command=${Inspectable.toStringUnknown(record.command, 0)} ` +
        `model=${Inspectable.toStringUnknown(record.model, 0)} ` +
        `expected=${Inspectable.toStringUnknown(record.expected, 0)} ` +
        `result=${Inspectable.toStringUnknown(record.actual.result, 0)} ` +
        `snapshot=${Inspectable.toStringUnknown(record.actual.snapshot, 0)} ` +
        `awaited=${Inspectable.toStringUnknown(record.actual.awaited, 0)} ` +
        `inspected=${Inspectable.toStringUnknown(record.actual.inspected, 0)}`
    )
  }
  if (failure) {
    if (value.attempted !== undefined) {
      lines.push(
        `attempted ${value.attempted.index}: command=${Inspectable.toStringUnknown(value.attempted.command, 0)} ` +
          `model=${Inspectable.toStringUnknown(value.attempted.model, 0)} ` +
          `expected=${Inspectable.toStringUnknown(value.attempted.expected, 0)} ` +
          `result=${Inspectable.toStringUnknown(value.attempted.result, 0)} ` +
          `snapshot=${Inspectable.toStringUnknown(value.attempted.snapshot, 0)} ` +
          `awaited=${Inspectable.toStringUnknown(value.attempted.awaited, 0)} ` +
          `inspected=${Inspectable.toStringUnknown(value.attempted.inspected, 0)}`
      )
    }
    lines.push(
      `failure: phase=${value.phase} index=${value.index} command=${Inspectable.toStringUnknown(value.command, 0)} ` +
        `cause=${Inspectable.toStringUnknown(value.cause, 0)}`
    )
  } else {
    lines.push(`final: snapshot=${Inspectable.toStringUnknown(value.final, 0)}`)
  }
  return lines.join("\n")
}
