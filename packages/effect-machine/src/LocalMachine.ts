/**
 * Runs machines in memory, as scoped resources of the current process.
 *
 * `Machine` declares a model and plans its steps. `LocalMachine` is the host
 * that executes them without storage or distribution: {@link start} and
 * {@link resume} return a live reference, and {@link prepare} exposes the
 * machine's streams before it initializes.
 *
 * @since 0.48.0
 */

import type * as Cause from "effect/Cause"
import type * as Effect from "effect/Effect"
import type * as Exit from "effect/Exit"
import type * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import type * as Stream from "effect/Stream"
import * as internal from "./internal/machine/process.js"
import type { EnsureExecutable } from "./internal/machine/readiness.js"
import type {
  ChildMachineRuntime,
  InfiniteTransitionError,
  InvocationSupport,
  Machine,
  MachineRef,
  MachineRuntime,
  MachineSchemaDecodeError,
  RuntimeSnapshot,
  StartupError,
  StoppedError
} from "./Machine.js"

/**
 * Resolves the services a local machine requires from its environment.
 *
 * **When to use**
 *
 * Use when writing a generic API that starts local machines, to name the
 * services its caller must provide.
 *
 * **Details**
 *
 * Removes `Machine.MachineRuntime` and `Machine.ChildMachineRuntime` from the
 * machine's requirements, because the running machine provides them to the work
 * it runs, and every
 * `Machine.InvocationSupport`, because a local machine runs every kind of
 * invocation.
 *
 * @category utility types
 * @since 0.48.0
 */
export type RequiredServices<Requirements> = Exclude<
  Requirements,
  MachineRuntime | ChildMachineRuntime | InvocationSupport<InvocationSupport.Kind>
>

/**
 * Live, root-scoped records describing one prepared machine tree.
 *
 * Inspection records deliberately erase machine-specific values to `unknown`:
 * one stream may contain unrelated root, child-machine, and `Logic` protocols.
 * The record structure remains a closed discriminated union, while typed
 * application observation continues through `changes` and `emissions`.
 * Records retain decoded local events and snapshots and are not themselves a
 * stable JSON export format. Telemetry exporters must project process-local
 * values into an explicit portable representation.
 *
 * @category models
 * @since 0.48.0
 */
export declare namespace Inspection {
  /** Read-only identity of a local machine endpoint. */
  export interface Endpoint {
    readonly id: string
    readonly sessionId: string
  }

  /** Read-only identity of a runtime represented in the inspection tree. */
  export interface Subject extends Endpoint {
    readonly kind: "Machine" | "Logic"
  }

  /** Causal origin of an inspected runtime. */
  export type Origin =
    | { readonly _tag: "Root" }
    | {
      readonly _tag: "Invoke"
      readonly ownerPath: string
      readonly invokeId: string
    }
    | {
      readonly _tag: "Spawn"
      readonly address: string | undefined
    }

  /** Causal owner of a send or emission. */
  export type Causation =
    | { readonly _tag: "Initialization" }
    | { readonly _tag: "Macrostep"; readonly macrostepId: number }
    | { readonly _tag: "ProgramInvocation"; readonly invocationSessionId: string }

  /** Closed command projection safe for observation. */
  export type Command =
    | {
      readonly _tag: "SendTo"
      readonly target: Endpoint | { readonly id: string }
      readonly event: unknown
    }
    | {
      readonly _tag: "Stop"
      readonly target: Endpoint | { readonly id: string }
    }

  /** One statechart microstep in a committed macrostep. */
  export interface Microstep {
    readonly event: unknown
    readonly transitions: ReadonlyArray<Machine.RetainedTransition>
    readonly raisedEvents: ReadonlyArray<unknown>
    readonly emittedEvents: ReadonlyArray<unknown>
    readonly commands: ReadonlyArray<Command>
    readonly exitPaths: ReadonlyArray<string>
    readonly entryPaths: ReadonlyArray<string>
    readonly changed: boolean
  }

  /** Common ordering and identity fields for every record. */
  export interface Base {
    /** Total publication order within this prepared root. */
    readonly sequence: number
    /** Session id of the prepared root that owns this inspection stream. */
    readonly rootSessionId: string
    /** Runtime instance described by this record. */
    readonly subject: Subject
  }

  /** Announces allocation of a root or owned process identity. */
  export interface Created extends Base {
    readonly _tag: "Created"
    readonly parent: Subject | undefined
    readonly origin: Origin
    /** Compiled statechart definition; absent for generic `Logic`. */
    readonly definition: Machine.Any | undefined
  }

  /** Announces successful initialization. */
  export interface Initialized extends Base {
    readonly _tag: "Initialized"
    readonly snapshot: RuntimeSnapshot<unknown, unknown, unknown>
    readonly initialEntryPaths: ReadonlyArray<string>
    readonly microsteps: ReadonlyArray<Microstep>
  }

  /** Announces failure before an initial runtime snapshot exists. */
  export interface StartFailed extends Base {
    readonly _tag: "StartFailed"
    readonly cause: Cause.Cause<unknown>
  }

  /** Announces acceptance of an event by a local mailbox. */
  export interface EventSent extends Base {
    readonly _tag: "EventSent"
    readonly deliveryId: number
    readonly source: Subject | undefined
    readonly target: Endpoint
    readonly event: unknown
    readonly causedBy: Causation | undefined
  }

  /** Announces complete processing of one statechart mailbox event. */
  export interface EventProcessed extends Base {
    readonly _tag: "EventProcessed"
    readonly macrostepId: number
    readonly deliveryId: number
    readonly source: Subject | undefined
    readonly event: unknown
    readonly before: RuntimeSnapshot<unknown, unknown, unknown>
    readonly after: RuntimeSnapshot<unknown, unknown, unknown>
    readonly handled: boolean
    readonly configurationChanged: boolean
    readonly microsteps: ReadonlyArray<Microstep>
  }

  /** Announces a direct state update made by generic `Logic`. */
  export interface StateChanged extends Base {
    readonly _tag: "StateChanged"
    readonly before: unknown
    readonly after: unknown
    readonly causedByDeliveryId: number | undefined
  }

  /** Announces actual publication on a machine's domain emission stream. */
  export interface Emitted extends Base {
    readonly _tag: "Emitted"
    readonly emission: unknown
    readonly causedBy: Causation | undefined
  }

  /**
   * Identity of one run of an invoked program: an Effect, a Stream, or a timer.
   *
   * A program has no state or mailbox of its own, so its records name the machine
   * that owns it as their subject. An invoked child machine or `Logic` process is
   * a subject itself, and its `Created` record has an `Invoke` origin instead.
   */
  export interface ProgramInvocation {
    readonly id: string
    readonly sessionId: string
    readonly owner: Subject
    readonly ownerPath: string
    readonly kind: "Effect" | "Stream" | "Timer"
  }

  /** Announces an invoked Effect, Stream, or timer starting. */
  export interface ProgramInvocationStarted extends Base {
    readonly _tag: "ProgramInvocationStarted"
    readonly invocation: ProgramInvocation
  }

  /** Announces the outcome of an invoked Effect, Stream, or timer. */
  export interface ProgramInvocationStopped extends Base {
    readonly _tag: "ProgramInvocationStopped"
    readonly invocation: ProgramInvocation
    /** Success or failure from the invoke; interruption means its owner stopped it. */
    readonly exit: Exit.Exit<unknown, unknown>
  }

  /** Announces a terminal local runtime snapshot. */
  export interface Terminated extends Base {
    readonly _tag: "Terminated"
    readonly snapshot: RuntimeSnapshot<unknown, unknown, unknown>
  }

  /** Complete live inspection protocol. */
  export type Event =
    | Created
    | Initialized
    | StartFailed
    | EventSent
    | EventProcessed
    | StateChanged
    | Emitted
    | ProgramInvocationStarted
    | ProgramInvocationStopped
    | Terminated
}

/**
 * A fresh local machine whose observable streams exist before initialization.
 *
 * Subscribe to `emissions` before evaluating `start` when initial-entry
 * emissions must be observed. `start` is one-shot: concurrent and repeated
 * evaluations share the same initialization and running reference, and the
 * `Scope` of the first evaluation owns the machine.
 *
 * @category models
 * @since 0.48.0
 */
export interface Prepared<out State, in Event, out Error, out Output, out Emitted, out StartError, StartRequirements> {
  /** Stable machine definition id, or a generated fallback when none was declared. */
  readonly id: string

  /** Unique identity reserved for this prepared machine instance. */
  readonly sessionId: string

  /** Waits for startup, then streams the initial lifecycle snapshot and later changes. */
  readonly changes: Stream.Stream<RuntimeSnapshot<State, Error, Output>, StartError>

  /** Streams ephemeral notifications published after subscription. */
  readonly emissions: Stream.Stream<Emitted>

  /**
   * Streams ordered operational records for this root and every locally owned
   * descendant. The stream is hot, non-replayed, never fails, and completes
   * after the prepared root terminates. Subscribe before evaluating `start` to
   * observe initialization.
   */
  readonly inspection: Stream.Stream<Inspection.Event>

  /** Initializes this machine once, owned by the first evaluating `Scope`, and returns its running reference. */
  readonly start: Effect.Effect<MachineRef<State, Event, Error, Output, Emitted>, StartError, StartRequirements>
}

/**
 * Prepares a fresh local machine without initializing it.
 *
 * Use this constructor when observation must be composed before initial-entry
 * actions run. Subscribe to `prepared.emissions`, then evaluate
 * `prepared.start`. Ordinary callers can continue to use {@link start}, which
 * starts directly and does not allocate the prepared lifecycle boundary.
 *
 * `prepared.start` is one-shot and scoped: the `Scope` that first evaluates it
 * owns the machine, and closing that `Scope` is equivalent to `ref.stop`.
 *
 * **Example** (Observing emissions before startup)
 *
 * ```ts import.meta.vitest
 * import { LocalMachine, Machine } from "@typeonce/effect-machine"
 * import { Effect, Stream } from "effect"
 *
 * const Emitted = Machine.emittedEvents({ Started: {} })
 * const machine = Machine.make({
 *   root: Machine.state({ states: { Idle: {} } }),
 *   events: Machine.events({}),
 *   emittedEvents: Emitted
 * }).handle({
 *   initial: { target: "Idle" },
 *   states: {
 *     Idle: {
 *       entry: (_, enqueue) => {
 *         enqueue.emit(Emitted.Started())
 *       }
 *     }
 *   }
 * })
 *
 * const emitted = Effect.scoped(Effect.gen(function*() {
 *   const prepared = yield* LocalMachine.prepare(machine)
 *   const seen: Array<string> = []
 *   yield* prepared.emissions.pipe(
 *     Stream.runForEach((event) => Effect.sync(() => seen.push(event._tag))),
 *     Effect.forkScoped({ startImmediately: true })
 *   )
 *   yield* prepared.start
 *   yield* Effect.yieldNow
 *   return seen
 * }))
 *
 * await Effect.runPromise(emitted) // => ["Started"]
 * ```
 *
 * @category constructors
 * @since 0.48.0
 */
export const prepare: <
  const States extends Machine.StateSchemas,
  const Events extends ReadonlyArray<Machine.TaggedSchema>,
  const Emits extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
  const Input extends Schema.Top = typeof Schema.Void,
  UnhandledStates extends Machine.StateIdentifier<States> = Machine.StateIdentifier<States>,
  E = never,
  R = never,
  FinalStates extends Machine.StateIdentifier<States> = never,
  Output = never,
  OutputStates extends Machine.StateIdentifier<States> = never,
  InputEvents extends ReadonlyArray<Machine.TaggedSchema> = Events,
  ParentEvents extends ReadonlyArray<Machine.TaggedSchema> = readonly []
>(
  machine:
    & Machine<
      States,
      Events,
      Input,
      UnhandledStates,
      E,
      R,
      FinalStates,
      Output,
      Emits,
      OutputStates,
      InputEvents,
      ParentEvents
    >
    & EnsureExecutable<States, UnhandledStates, OutputStates>
    & Machine.RootCompatible<ParentEvents>,
  ...args: [...Machine.InputArgs<Input>]
) => Effect.Effect<
  Prepared<
    Machine.Snapshot<States>,
    Machine.EventInputOf<InputEvents>,
    | E
    | InfiniteTransitionError
    | MachineSchemaDecodeError
    | StoppedError,
    Output,
    Machine.EmittedEventOf<Emits>,
    | E
    | InfiniteTransitionError
    | MachineSchemaDecodeError
    | StartupError
    | StoppedError,
    | Scope.Scope
    | RequiredServices<R>
  >
> = internal.prepare

/**
 * Starts a machine in memory, owned by the current `Scope`.
 *
 * **When to use**
 *
 * Use when you want asynchronous event delivery, lifecycle snapshots, `join`,
 * and machine-owned spawned or invoked children.
 *
 * **Details**
 *
 * For each accepted event the runtime plans the complete synchronous
 * macrostep, executes closed machine commands, stops invokes for exited states,
 * publishes the new state, delivers emitted events, and then starts invokes
 * for entered states.
 *
 * An event sent to an idle machine is processed in the sender's turn: work that
 * completes without suspending is reflected by `snapshot` when `send` returns.
 * Work invoked by an entered state also starts in the sender's turn and runs
 * until it first suspends, so browser APIs that require user activation, such as
 * `window.open`, can run in the first step of an invoked Effect. Work that
 * suspends continues in the background. Its outcome is handled in a later turn,
 * even when the work completes without suspending, so the entered state is always
 * observed before the outcome leaves it. An event sent while the machine is
 * processing is queued behind the current work. `changes` subscribers receive
 * every committed snapshot in order once the sender yields, with consecutive
 * sends delivered together.
 *
 * The machine is a scoped resource, like `Effect.forkScoped`. Closing the
 * `Scope` is equivalent to `ref.stop`: active invocations are interrupted,
 * owned children stop, the snapshot becomes `stopped`, and later sends fail
 * with `StoppedError`. An earlier `ref.stop` or terminal completion leaves the
 * finalizer with nothing to do. Own a `Scope` explicitly, for example with
 * `Scope.make` and `Scope.provide`, when the machine must outlive the caller.
 *
 * **Gotchas**
 *
 * The delivery order above belongs to references of local machines. The
 * `Machine.MachineRef` contract promises only delivery.
 *
 * Transition failures are reported through the runtime snapshot, `changes`, and
 * `join` rather than being returned by `send`. Sending after the machine reaches
 * any terminal state fails immediately with `StoppedError`.
 *
 * **Example** (Starting a machine in a scope)
 *
 * ```ts import.meta.vitest
 * import { LocalMachine, Machine } from "@typeonce/effect-machine"
 * import { Effect } from "effect"
 *
 * const States = Machine.state({ states: { Idle: {} } })
 * const machine = Machine.make({ root: States, events: Machine.events({}) }).handle({
 *   initial: { target: "Idle" }
 * })
 *
 * const path = Effect.scoped(Effect.gen(function*() {
 *   const ref = yield* LocalMachine.start(machine)
 *   return (yield* ref.state).state.path
 * }))
 *
 * await Effect.runPromise(path) // => "Idle"
 * ```
 *
 * @see {@link prepare} for observing a machine before it initializes.
 * @see {@link resume} for starting from a decoded snapshot.
 * @category constructors
 * @since 0.48.0
 */
export const start: <
  const States extends Machine.StateSchemas,
  const Events extends ReadonlyArray<Machine.TaggedSchema>,
  const Emits extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
  const Input extends Schema.Top = typeof Schema.Void,
  UnhandledStates extends Machine.StateIdentifier<States> = Machine.StateIdentifier<States>,
  E = never,
  R = never,
  FinalStates extends Machine.StateIdentifier<States> = never,
  Output = never,
  OutputStates extends Machine.StateIdentifier<States> = never,
  InputEvents extends ReadonlyArray<Machine.TaggedSchema> = Events,
  ParentEvents extends ReadonlyArray<Machine.TaggedSchema> = readonly []
>(
  machine:
    & Machine<
      States,
      Events,
      Input,
      UnhandledStates,
      E,
      R,
      FinalStates,
      Output,
      Emits,
      OutputStates,
      InputEvents,
      ParentEvents
    >
    & EnsureExecutable<States, UnhandledStates, OutputStates>
    & Machine.RootCompatible<ParentEvents>,
  ...args: [...Machine.InputArgs<Input>]
) => Effect.Effect<
  MachineRef<
    Machine.Snapshot<States>,
    Machine.EventInputOf<InputEvents>,
    | E
    | InfiniteTransitionError
    | MachineSchemaDecodeError
    | StoppedError,
    Output,
    Machine.EmittedEventOf<Emits>
  >,
  | E
  | InfiniteTransitionError
  | MachineSchemaDecodeError
  | StartupError
  | StoppedError,
  | Scope.Scope
  | RequiredServices<R>
> = internal.start

/**
 * Starts a fresh local machine from a decoded logical snapshot, owned by the
 * current `Scope`.
 *
 * **Details**
 *
 * The resumed machine has the same scoped lifetime as {@link start}: closing
 * the `Scope` is equivalent to `ref.stop`.
 *
 * `resume` validates and normalizes the supplied snapshot before publishing it
 * as the first state. It does not construct the declared initial state, replay
 * entry or transition actions, re-deliver raised or emitted events, or
 * re-evaluate historical completion and eventless transitions. Active-state
 * invokes start once in ancestor and document order with `Machine.InitialEvent`;
 * timer invocations restart their complete duration and child-machine
 * invocations start from their own initial state.
 *
 * Only logical state, completion, and history metadata are resumed. Queues,
 * scopes, subscriptions, fibers, spawned children, invoke progress, and prior
 * runtime status are process-local and are not restored. A final snapshot
 * immediately produces a completed ref with its current-machine output.
 *
 * Decode encoded data explicitly with `Machine.decodeSnapshot` before calling
 * this function. Stable snapshots are hosted as supplied; newly enabled
 * eventless or completion transitions in a changed machine definition are not
 * evaluated merely because the runtime was resumed; only ordinary subsequent
 * transition planning can enter and stabilize states.
 *
 * **Example** (Resuming from a decoded snapshot)
 *
 * ```ts import.meta.vitest
 * import { LocalMachine, Machine } from "@typeonce/effect-machine"
 * import { Effect } from "effect"
 *
 * const States = Machine.state({ states: { Idle: {} } })
 * const machine = Machine.make({ root: States, events: Machine.events({}) }).handle({
 *   initial: { target: "Idle" }
 * })
 *
 * const path = Effect.scoped(Effect.gen(function*() {
 *   const initial = yield* Machine.planInitial(machine)
 *   const encoded = yield* Machine.encodeSnapshot(machine, initial.state)
 *   const snapshot = yield* Machine.decodeSnapshot(machine, encoded)
 *   const ref = yield* LocalMachine.resume(machine, snapshot)
 *   return (yield* ref.state).state.path
 * }))
 *
 * await Effect.runPromise(path) // => "Idle"
 * ```
 *
 * @see {@link start} for ordinary initial startup.
 * @category constructors
 * @since 0.48.0
 */
export const resume: <
  const States extends Machine.StateSchemas,
  const Events extends ReadonlyArray<Machine.TaggedSchema>,
  const Emits extends ReadonlyArray<Machine.TaggedSchema> = readonly [],
  const Input extends Schema.Top = typeof Schema.Void,
  UnhandledStates extends Machine.StateIdentifier<States> = Machine.StateIdentifier<States>,
  E = never,
  R = never,
  FinalStates extends Machine.StateIdentifier<States> = never,
  Output = never,
  OutputStates extends Machine.StateIdentifier<States> = never,
  InputEvents extends ReadonlyArray<Machine.TaggedSchema> = Events,
  ParentEvents extends ReadonlyArray<Machine.TaggedSchema> = readonly []
>(
  machine:
    & Machine<
      States,
      Events,
      Input,
      UnhandledStates,
      E,
      R,
      FinalStates,
      Output,
      Emits,
      OutputStates,
      InputEvents,
      ParentEvents
    >
    & EnsureExecutable<States, UnhandledStates, OutputStates>
    & Machine.RootCompatible<ParentEvents>,
  snapshot: Machine.Snapshot<States>
) => Effect.Effect<
  MachineRef<
    Machine.Snapshot<States>,
    Machine.EventInputOf<InputEvents>,
    | E
    | InfiniteTransitionError
    | MachineSchemaDecodeError
    | StoppedError,
    Output,
    Machine.EmittedEventOf<Emits>
  >,
  MachineSchemaDecodeError,
  | Scope.Scope
  | RequiredServices<R>
> = internal.resume
