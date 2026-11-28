/**
 * The pure form of a machine: what its next state is, and which work a host
 * starts and stops, for hosts written outside the local runtime.
 *
 * Every function is synchronous and returns a value. The host state holds the
 * execution state of the plan, the work that runs, and how many entries of
 * invoking states have begun. Whether work is current is read from
 * the state that a caller passes back, and never from a handle shared with the
 * caller: work is current when that state lists the very object the caller
 * reports, so work of an earlier entry, of a step that was not kept, or of a
 * machine before it resumed, is never taken for the work that runs.
 *
 * A step plans with the execution plan of its machine, `compileExecutionPlan`,
 * which the compiled local runtime uses too: an indexed kernel for the machines
 * and events it covers, and the reference planner for anything else. The choice
 * is made once per machine.
 *
 * A step function has an {@link Ownership}. A `"Persistent"` step, which
 * `Machine.toStep` returns, takes and returns immutable state values. An
 * `"Owned"` step, for a host that keeps only its latest state, takes each state
 * over and may update its storage in place. Both are one implementation, which
 * differs only in whether a plan copies or updates what it writes.
 *
 * The order is the one of the generic runtime in `process.ts`: commands, the
 * work of exited states, the new state, emitted events, and the work of entered
 * states. A step calls no user code for the work it lists: each piece of work
 * evaluates its source and its input mapper when its host starts it, at most
 * once, inside its own startup failure boundary, as `invocationResolution.ts`
 * requires of a host.
 *
 * @since 0.48.0
 */

import * as Context from "effect/Context"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Equal from "effect/Equal"
import * as Exit from "effect/Exit"
import * as Hash from "effect/Hash"
import * as Stream from "effect/Stream"
import type { ChildMachine, ChildOwner, Logic, Machine, MachineTarget } from "../../Machine.js"
import { ChildMachineRuntime, MachineRuntime } from "./capability.js"
import * as CapturedInvocation from "./capturedInvocation.js"
import { isChildMachine } from "./child.js"
import type { RuntimeCommand } from "./command.js"
import * as Configuration from "./configuration.js"
import {
  isPlanningError,
  MachineSchemaDecodeError,
  ProcessLocalError,
  StoppedError,
  toStartupFailure
} from "./errors.js"
import * as ExecutionPlan from "./executionPlan.js"
import * as InvocationChanges from "./invocationChanges.js"
import * as InvocationEvent from "./invocationEvent.js"
import * as InvocationOutcome from "./invocationOutcome.js"
import * as InvocationResolution from "./invocationResolution.js"
import * as LogicScope from "./logicScope.js"
import * as Planner from "./planner.js"
import * as Protocol from "./protocol.js"
import * as Serialization from "./serialization.js"

/** @internal */
export const StateTypeId: unique symbol = Symbol.for("effect/Machine/MachineStep/State")

/** @internal */
export const WorkTypeId: unique symbol = Symbol.for("effect/Machine/MachineStep/Work")

/** @internal */
export const OwnershipTypeId: unique symbol = Symbol.for("effect/Machine/MachineStep/Ownership")

/**
 * Who owns the states that a step function takes.
 *
 * - `"Persistent"`: a state is an immutable value. A caller may keep it, step
 *   from it again, and read any step it returned at any time. Equal arguments
 *   give equal results. `Machine.toStep` returns these step functions.
 * - `"Owned"`: a caller hands each state over to the step function it passes
 *   it to, and never uses it again: neither that state nor any step that
 *   returned it. The step may update the storage of the state in place and
 *   reuse it for the state it returns. Passing a state that was handed over
 *   already throws, unless the step returned that very state. A host that keeps
 *   only its latest state, such as the local runtime, uses these.
 *
 * Both give equal results for the same inputs, as long as an owned step's
 * results are read before its state is handed over.
 *
 * @internal
 */
export type Ownership = ExecutionPlan.ExecutionOwnership

type AnyLogic = Logic<unknown, unknown, unknown, unknown, unknown, unknown>

/** Selects a child of the running machine: a typed address, or a child machine descriptor. */
type ChildSelector = string | ChildMachine.Any

interface WorkBase {
  readonly [WorkTypeId]: InvocationResolution.ResolvedInvocation
  readonly path: string
  readonly id: string
  readonly source: string | undefined
  readonly run: number
}

/**
 * One piece of work. Each accessor evaluates user code at most once, and
 * returns its failure instead of throwing.
 *
 * @internal
 */
export type Work =
  | WorkBase & {
    readonly _tag: "Effect"
    readonly effect: () => Exit.Exit<Effect.Effect<unknown, unknown, unknown>>
  }
  | WorkBase & {
    readonly _tag: "Timer"
    readonly duration: () => Exit.Exit<Duration.Duration>
    readonly effect: () => Exit.Exit<Effect.Effect<void>>
  }
  | WorkBase & {
    readonly _tag: "Stream"
    readonly stream: () => Exit.Exit<Stream.Stream<unknown, unknown, unknown>>
  }
  | WorkBase & {
    readonly _tag: "Logic"
    readonly address: string
    readonly logic: () => Exit.Exit<AnyLogic>
  }
  | WorkBase & {
    readonly _tag: "Child"
    readonly child: ChildMachine.Any
    readonly input: () => Exit.Exit<ReadonlyArray<unknown>>
  }

/**
 * What a transition asked of the host, in order.
 *
 * @internal
 */
export type Command =
  | { readonly _tag: "Send"; readonly target: MachineTarget<unknown>; readonly event: unknown }
  | {
    readonly _tag: "SendToChild"
    readonly child: ChildSelector
    readonly work: Work | undefined
    readonly event: unknown
  }
  | { readonly _tag: "StopChild"; readonly child: ChildSelector; readonly work: Work | undefined }

/**
 * Operations on the children of the running machine, which its host owns.
 *
 * @internal
 */
export interface Children {
  readonly spawn: (
    child: ChildMachine.Any,
    options: { readonly input: unknown } | undefined
  ) => Effect.Effect<unknown, unknown, unknown>
  readonly spawnLogic: (
    logic: AnyLogic,
    options: { readonly id?: string | undefined } | undefined
  ) => Effect.Effect<unknown, unknown, unknown>
  readonly sendTo: (child: ChildSelector, event: unknown) => Effect.Effect<void, StoppedError>
  readonly stop: (child: ChildSelector) => Effect.Effect<void>
}

/** @internal */
export interface Options {
  readonly self: MachineTarget<any>
  readonly parent?: MachineTarget<any> | undefined
  readonly children?: Children | undefined
}

/** @internal */
export interface Progress {
  readonly path: string
  readonly id: string
  readonly status: "Ended" | "Running"
}

/**
 * A microstep of a plan. Its state is an execution state of the plan, or a
 * snapshot already for the initial plan.
 */
type PlannedMicrostep = ExecutionPlan.ExecutionMicrostep

/** A microstep as a step publishes it. */
interface PublishedMicrostep {
  readonly next: Machine.Snapshot<any>
  readonly event: unknown
  readonly transitions: ReadonlyArray<Machine.RetainedTransition>
  readonly commands: ReadonlyArray<RuntimeCommand>
  readonly raisedEvents: ReadonlyArray<unknown>
  readonly emittedEvents: ReadonlyArray<unknown>
  readonly exitPaths: ReadonlyArray<string>
  readonly entryPaths: ReadonlyArray<string>
  readonly changed: boolean
}

/**
 * The machine of a step function, the plan it steps with, and the host it runs
 * on: what its transitions address, and the children its work acts on. A host
 * builds one for each machine it runs, and every state of that machine carries
 * it. What work needs of it is built when work first needs it, so a machine
 * that invokes nothing holds only these fields.
 *
 * @internal
 */
export class Planning implements Configuration.PlanningMachineReferences {
  #services: Context.Context<MachineRuntime | ChildMachineRuntime> | undefined

  constructor(
    readonly machine: Machine.Any,
    readonly plan: ExecutionPlan.CompiledExecutionPlan,
    readonly self: MachineTarget<any>,
    readonly parent: MachineTarget<any> | undefined,
    /** The children of the machine, or `undefined` for a host that owns them itself. */
    children: Children | undefined,
    /**
     * Whether the host runs work inside the services of this machine already,
     * as the local runtime runs work in processes of the machine, so work is
     * not provided them again.
     */
    readonly ambient = false
  ) {
    this.children = children ?? (this as unknown as Children)
  }

  readonly children: Children

  // A host is compared by identity: hashing a state, as a failure that holds one
  // may be hashed, never reads the targets of the host.
  [Hash.symbol](): number {
    return Hash.random(this)
  }

  [Equal.symbol](that: unknown): boolean {
    return this === that
  }

  /** What the source and input mapper of work receive, built for each entry that resolves work. */
  get capabilities(): InvocationResolution.InvocationCapabilities {
    return { self: this.self, parent: this.parent, children: childOwnerOf(this.children) }
  }

  /** The services through which work acts on the children of this machine. */
  get services(): Context.Context<MachineRuntime | ChildMachineRuntime> {
    return this.#services ??= servicesOf(this.children)
  }
}

const empty: ReadonlyArray<never> = []

/**
 * The host state. `execution` is the execution state of the plan, which
 * carries no machine references: they are attached for each plan, as the local
 * runtime attaches them. The configuration and the public snapshot are built
 * from it on first read.
 *
 * A state that rests holds only its snapshot, its work and its runs: its
 * execution state is built again from the snapshot when a step needs it, as a
 * host that keeps a machine idle does not hold it.
 *
 * A `"Persistent"` state never changes after it is built. The `execution` of
 * an `"Owned"` state is written in place by the step that it is handed over to,
 * and so is everything read from it that was not read before.
 *
 * @internal
 */
export class State<O extends Ownership = "Persistent"> {
  declare readonly [StateTypeId]: typeof StateTypeId
  declare readonly [OwnershipTypeId]: O
  #execution: unknown
  #configuration: Configuration.ActiveConfiguration | undefined
  #snapshot: Machine.Snapshot<any> | undefined
  /** Whether an owned state was handed over to a step, which may have written it. */
  #handedOver = false

  constructor(
    readonly planning: Planning,
    /** The execution state of the plan, or `undefined` for a state that rests. */
    execution: unknown,
    configuration: Configuration.ActiveConfiguration | undefined,
    snapshot: Machine.Snapshot<any> | undefined,
    /** The work that runs, in start order. */
    readonly running: ReadonlyArray<Work>,
    /** How many entries of invoking states have begun: the run of the next one. */
    readonly runs: number,
    readonly exit: Exit.Exit<unknown, unknown> | undefined
  ) {
    this.#execution = execution
    this.#configuration = configuration
    this.#snapshot = snapshot
  }

  get machine(): Machine.Any {
    return this.planning.machine
  }

  /** The execution state of the plan. Building it again from the snapshot may throw. */
  get execution(): unknown {
    return this.#execution ??= this.planning.plan.fromConfiguration(this.configuration)
  }

  get configuration(): Configuration.ActiveConfiguration {
    return this.#configuration ??= this.#execution === undefined
      ? Configuration.normalizeConfigurationSync(this.planning.machine, this.#snapshot!)
      : this.planning.plan.toConfiguration(this.#execution)
  }

  get snapshot(): Machine.Snapshot<any> {
    return this.#snapshot ??= this.planning.plan.snapshot(this.#execution)
  }

  /** This state with other running work, keeping what was read of it. */
  withRunning(running: ReadonlyArray<Work>): State<O> {
    return new State(this.planning, this.#execution, this.#configuration, this.#snapshot, running, this.runs, this.exit)
  }

  /** This state as it rests: its snapshot, its work and its runs. */
  resting(): State<O> {
    return new State(this.planning, undefined, undefined, this.snapshot, this.running, this.runs, this.exit)
  }

  /** What was built of this state, without building anything. */
  get built(): { readonly execution: unknown; readonly configuration: Configuration.ActiveConfiguration | undefined } {
    return { execution: this.#execution, configuration: this.#configuration }
  }

  /**
   * Hands an owned state over to one step. From this call on, the caller
   * promises never to reuse this state, nor any step that returned it: the step
   * may write it in place. Handing over a state twice throws.
   */
  handOverNeverReuse(): this {
    if (this.#handedOver) {
      throw new Error(
        "An owned MachineStep state was reused after it was handed over to a step: never reuse an owned state after passing it"
      )
    }
    this.#handedOver = true
    return this
  }

  /**
   * Gives an owned state back to its caller, only when the step returned this
   * very state unchanged, or refused the event: the caller may pass it again.
   */
  giveBackUnchanged(): void {
    this.#handedOver = false
  }
}

/** The paths that a step exited and entered. */
interface Paths {
  readonly exited: ReadonlyArray<string>
  readonly entered: ReadonlyArray<string>
}

const noPaths: Paths = { exited: empty, entered: empty }

const pathsOf = (microsteps: ReadonlyArray<InvocationChanges.Microstep>): Paths => {
  const changes = InvocationChanges.fromMicrosteps(microsteps)
  return changes === undefined
    ? noPaths
    : { exited: Array.from(new Set(changes.exited)), entered: Array.from(changes.entered.keys()) }
}

/**
 * What one step did. Its microsteps are made public on first read.
 *
 * @internal
 */
export class Step<O extends Ownership = "Persistent"> {
  #microsteps: ReadonlyArray<PlannedMicrostep> | undefined
  #published: ReadonlyArray<PublishedMicrostep> | undefined
  #paths: Paths | undefined

  constructor(
    readonly state: State<O>,
    readonly event: unknown,
    microsteps: ReadonlyArray<PlannedMicrostep>,
    readonly emitted: ReadonlyArray<unknown>,
    readonly commands: ReadonlyArray<Command>,
    readonly stop: ReadonlyArray<Work>,
    readonly start: ReadonlyArray<Work>,
    /** The paths of an initial step, which its microsteps do not list. Read from the microsteps otherwise. */
    paths?: Paths
  ) {
    this.#microsteps = microsteps
    this.#paths = paths
  }

  /** Paths of the states the step exited, in exit order, each once. */
  get exited(): ReadonlyArray<string> {
    return (this.#paths ??= pathsOf(this.#microsteps ?? this.#published!)).exited
  }

  /** Paths of the states the step entered, in entry order, each once. */
  get entered(): ReadonlyArray<string> {
    return (this.#paths ??= pathsOf(this.#microsteps ?? this.#published!)).entered
  }

  get snapshot(): Machine.Snapshot<any> {
    return this.state.snapshot
  }

  /** Whether the step planned a microstep, so its state is a new one to publish. */
  get planned(): boolean {
    return (this.#microsteps ?? this.#published!).length > 0
  }

  get running(): ReadonlyArray<Work> {
    return this.state.running
  }

  get exit(): Exit.Exit<unknown, unknown> | undefined {
    return this.state.exit
  }

  get microsteps(): ReadonlyArray<PublishedMicrostep> {
    if (this.#published === undefined) {
      const plan = this.state.planning.plan
      const planned = this.#microsteps!
      this.#microsteps = undefined
      // Initial planning has published its microsteps already.
      this.#published = planned.length === 0 || this.event === Planner.InitialEvent
        ? planned as ReadonlyArray<PublishedMicrostep>
        : planned.map((microstep): PublishedMicrostep => ({
          next: plan.snapshot(microstep.next),
          event: microstep.event,
          transitions: microstep.transitions!,
          commands: microstep.commands,
          raisedEvents: microstep.raisedEvents,
          emittedEvents: microstep.emittedEvents,
          exitPaths: microstep.exitPaths,
          entryPaths: microstep.entryPaths,
          changed: microstep.changed
        }))
    }
    return this.#published
  }
}

/**
 * The step functions of a machine. Each one takes a state of its own
 * {@link Ownership}.
 *
 * @internal
 */
export interface MachineStep<O extends Ownership = "Persistent"> {
  readonly start: (...input: ReadonlyArray<unknown>) => Exit.Exit<Step<O>, unknown>
  readonly send: (state: State<O>, event: unknown) => Exit.Exit<Step<O>, unknown>
  /**
   * Plans an event that its host decoded already, as `send` does after it
   * decodes. A machine that has ended takes no event: its host stops sending.
   */
  readonly sendDecoded: (state: State<O>, event: Machine.EventOf<any>) => Step<O>
  readonly settle: (state: State<O>, work: Work, exit: Exit.Exit<unknown, unknown>) => Step<O>
  readonly element: (state: State<O>, work: Work, element: unknown) => Step<O>
  readonly report: (state: State<O>, work: Work, snapshot: unknown) => Step<O>
  readonly stop: (state: State<O>) => Step<O>
  readonly resume: (
    snapshot: Machine.Snapshot<any>,
    progress?: ReadonlyArray<Progress>
  ) => Exit.Exit<Step<O>, unknown>
}

/**
 * Step functions that take each state over, for a host that keeps only its
 * latest state. See {@link Ownership}.
 *
 * @internal
 */
export type OwnedMachineStep = MachineStep<"Owned">

/**
 * The step functions of a machine, built once for each machine, ownership and
 * planner, for every host that runs it. A state carries the {@link Planning}
 * of its host, so only `start` and `resume`, which take no state, are passed
 * one.
 *
 * @internal
 */
export interface Kernel<O extends Ownership>
  extends Omit<MachineStep<O>, "start" | "resume" | "sendDecoded" | "settle" | "element" | "report">
{
  readonly plan: ExecutionPlan.CompiledExecutionPlan
  /**
   * As in {@link MachineStep}. A host that reads no microstep of the step it
   * gets passes `retain: false`, so an owned plan writes in place and keeps no
   * transition; the step still lists the paths it exited and entered.
   */
  readonly sendDecoded: (state: State<O>, event: Machine.EventOf<any>, retain?: boolean) => Step<O>
  readonly settle: (state: State<O>, work: Work, exit: Exit.Exit<unknown, unknown>, retain?: boolean) => Step<O>
  readonly element: (state: State<O>, work: Work, element: unknown, retain?: boolean) => Step<O>
  readonly report: (state: State<O>, work: Work, snapshot: unknown, retain?: boolean) => Step<O>
  /**
   * Starts the machine with `input`. Without `retain`, a machine that the
   * execution plan starts itself starts there, and its step lists no microstep.
   */
  readonly start: (
    planning: Planning,
    input: ReadonlyArray<unknown>,
    retain?: boolean
  ) => Exit.Exit<Step<O>, unknown>
  readonly resume: (
    planning: Planning,
    snapshot: Machine.Snapshot<any>,
    progress?: ReadonlyArray<Progress>
  ) => Exit.Exit<Step<O>, unknown>
  /**
   * The state of an active machine that invokes no work, from a snapshot that
   * its host published: a host that keeps only that snapshot while the machine
   * is idle builds its state again with it. It throws for a machine that
   * invokes work, whose work a snapshot does not hold, and for a snapshot that
   * does not normalize.
   */
  readonly fromSnapshot: (planning: Planning, snapshot: Machine.Snapshot<any>) => State<O>
  /**
   * The state as it rests, for a host that keeps a machine idle: its snapshot,
   * its work and its runs. A later step builds its execution state again from
   * the snapshot. An owned state is handed over.
   */
  readonly rest: (state: State<O>) => State<O>
}

/** @internal */
export const isState = (value: unknown): value is State<Ownership> => value instanceof State

/**
 * One piece of work, as a step lists it. What it describes is read from its
 * invocation, and each accessor evaluates user code once and keeps its result,
 * so a piece of work holds no closure of its own. Work is compared by identity.
 */
class WorkOf {
  #evaluated: Exit.Exit<unknown> | undefined
  readonly [WorkTypeId]: InvocationResolution.ResolvedInvocation

  constructor(
    invocation: InvocationResolution.ResolvedInvocation,
    readonly run: number,
    private readonly planning: Planning
  ) {
    this[WorkTypeId] = invocation
  }

  [Hash.symbol](): number {
    return Hash.random(this)
  }

  [Equal.symbol](that: unknown): boolean {
    return this === that
  }

  get _tag(): Work["_tag"] {
    return this[WorkTypeId]._tag
  }

  get path(): string {
    return this[WorkTypeId].path
  }

  get id(): string {
    return this[WorkTypeId].id
  }

  get source(): string | undefined {
    const invocation = this[WorkTypeId]
    return invocation._tag === "Child" ? undefined : invocation.sourceName
  }

  get address(): string | undefined {
    const invocation = this[WorkTypeId]
    return invocation._tag === "Logic" ? invocation.address : undefined
  }

  get child(): ChildMachine.Any | undefined {
    const invocation = this[WorkTypeId]
    return invocation._tag === "Child" ? invocation.child : undefined
  }

  /** Evaluates user code once, and keeps its result or its throw. */
  private evaluate<A>(evaluate: (invocation: any) => A): Exit.Exit<A> {
    if (this.#evaluated === undefined) {
      try {
        this.#evaluated = Exit.succeed(evaluate(this[WorkTypeId]))
      } catch (error) {
        this.#evaluated = Exit.die(error)
      }
    }
    return this.#evaluated as Exit.Exit<A>
  }

  /** Work acts on the children of its machine through the services of its host. */
  private provide<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, unknown> {
    const planning = this.planning
    return planning.ambient
      ? effect
      : Effect.updateContext(effect, (context: Context.Context<unknown>) => Context.merge(context, planning.services))
  }

  effect(): Exit.Exit<Effect.Effect<unknown, unknown, unknown>> {
    if (this[WorkTypeId]._tag === "Timer") return Exit.map(this.duration(), Effect.sleep)
    // Each run owns a scope, closed with its exit, as on the local runtime.
    return this.evaluate((invocation: InvocationResolution.EffectInvocation) =>
      this.provide(Effect.scoped(invocation.effect()))
    )
  }

  duration(): Exit.Exit<Duration.Duration> {
    return this.evaluate((invocation: InvocationResolution.TimerInvocation) => invocation.duration())
  }

  stream(): Exit.Exit<Stream.Stream<unknown, unknown, unknown>> {
    // A run of a Stream owns a scope too, closed with its end or its stop.
    return this.evaluate((invocation: InvocationResolution.StreamInvocation) => {
      const planning = this.planning
      const stream = Stream.scoped(invocation.stream())
      return planning.ambient
        ? stream
        : Stream.updateContext(stream, (context: Context.Context<unknown>) => Context.merge(context, planning.services))
    })
  }

  logic(): Exit.Exit<AnyLogic> {
    return this.evaluate((invocation: InvocationResolution.LogicInvocation) => {
      const scoped = LogicScope.scoped(invocation.logic())
      if (this.planning.ambient) return scoped
      return {
        initial: (context) => this.provide(scoped.initial(context)),
        run: (context) => this.provide(scoped.run(context))
      }
    })
  }

  input(): Exit.Exit<ReadonlyArray<unknown>> {
    return this.evaluate((invocation: Extract<InvocationResolution.ResolvedInvocation, { readonly _tag: "Child" }>) =>
      invocation.input === undefined ? empty : [invocation.input()]
    )
  }
}

const unchanged = <O extends Ownership>(state: State<O>): Step<O> =>
  new Step(state, undefined, empty, empty, empty, empty, empty)

/** A planning throw: typed for the planner's own errors, a defect otherwise. */
const exitOfThrow = (error: unknown): Exit.Exit<never, unknown> =>
  isPlanningError(error) ? Exit.fail(error) : Exit.die(error)

/** The work that runs in a state, latest first, as a host stops it when its machine ends. */
const latestFirst = (running: ReadonlyArray<Work>): ReadonlyArray<Work> =>
  running.length < 2 ? running : running.slice().reverse()

/** Whether a running piece of work is the child that a command selects, as the local registry matches it. */
const selects = (work: Work, child: ChildSelector): boolean =>
  typeof child === "string"
    ? (work._tag === "Logic" && work.address === child) || (work._tag === "Child" && work.child.id === child)
    : work._tag === "Child" && work.child.id === child.id && work.child.machine === child.machine

const refuse = (operation: string): Effect.Effect<never> => Effect.die(new ProcessLocalError({ operation }))

// A host that supplies no children owns none, as on Cluster.
const refusedChildren: Children = {
  spawn: () => refuse("children.spawn"),
  spawnLogic: () => refuse("spawn"),
  sendTo: () => refuse("sendTo"),
  stop: () => refuse("stopChild")
}

const childOwnerOf = (children: Children): ChildOwner<any> => ({
  spawn:
    ((child: ChildMachine.Any, ...options: ReadonlyArray<{ readonly input: unknown }>) =>
      children.spawn(child, options[0])) as ChildOwner<any>["spawn"],
  sendTo: (child, event) => children.sendTo(child, event),
  stop: (child) => children.stop(child)
})

const servicesOf = (children: Children): Context.Context<MachineRuntime | ChildMachineRuntime> =>
  Context.make(
    MachineRuntime,
    MachineRuntime.of({
      spawn: ((logic: AnyLogic, options?: { readonly id?: string }) =>
        children.spawnLogic(logic, options)) as MachineRuntime["Service"]["spawn"],
      sendTo: (child, event) =>
        children.sendTo(child as ChildSelector, event),
      stopChild: (child) => children.stop(child as ChildSelector)
    })
  ).pipe(
    Context.add(
      ChildMachineRuntime,
      ChildMachineRuntime.of({
        sendTo: (child, event) => children.sendTo(child, event),
        stopChild: (child) => children.stop(child)
      })
    )
  )

/** The paths whose states invoke work. */
const invokingPathsCache = new WeakMap<Machine.Any, ReadonlySet<string>>()

const invokingPaths = (machine: Machine.Any): ReadonlySet<string> => {
  let paths = invokingPathsCache.get(machine)
  if (paths === undefined) {
    const invoking = new Set<string>()
    for (const path of machine.stateNodes.byPath.keys()) {
      if (CapturedInvocation.list(Configuration.getStateConfigByPath(machine, path)?.invoke).length > 0) {
        invoking.add(path)
      }
    }
    paths = invoking
    invokingPathsCache.set(machine, paths)
  }
  return paths
}

/**
 * The step functions of `machine`, which plan with `plan` and take states of
 * `ownership`. The ownership is passed to every plan, which copies what it
 * writes in a persistent state and writes an owned one in place: that is the
 * only difference between the two.
 */
const build = <O extends Ownership>(
  machine: Machine.Any,
  ownership: O,
  plan: ExecutionPlan.CompiledExecutionPlan
): Kernel<O> => {
  // A machine that invokes no work runs none, so its steps track none.
  const invoking = invokingPaths(machine)

  /** Describes one invocation, without calling any of its user code. */
  const describe = (
    planning: Planning,
    invocation: InvocationResolution.ResolvedInvocation,
    run: number
  ): Work => new WorkOf(invocation, run, planning) as unknown as Work

  /**
   * Commands of a transition, as data, in order. A command that selects a
   * child names the running work it selects, which a stop ends.
   */
  const commandsOf = (
    commands: ReadonlyArray<RuntimeCommand>,
    running: ReadonlyArray<Work>
  ): { readonly commands: ReadonlyArray<Command>; readonly running: ReadonlyArray<Work> } => {
    if (commands.length === 0) return { commands: empty, running }
    const out: Array<Command> = []
    let current = running
    for (const command of commands) {
      if (command._tag === "Stop") {
        const child = command.child as ChildSelector
        const work = current.find((work) => selects(work, child))
        if (work !== undefined) current = current.filter((other) => other !== work)
        out.push({ _tag: "StopChild", child, work })
        continue
      }
      const target = command.target
      if (typeof target === "string" || isChildMachine(target)) {
        const child = target as ChildSelector
        out.push({
          _tag: "SendToChild",
          child,
          work: current.find((work) => selects(work, child)),
          event: command.event
        })
      } else {
        out.push({ _tag: "Send", target, event: command.event })
      }
    }
    return { commands: out, running: current }
  }

  interface Published {
    readonly event: unknown
    readonly microsteps: ReadonlyArray<PlannedMicrostep>
    readonly emitted: ReadonlyArray<unknown>
    readonly commands: ReadonlyArray<Command>
    /** The paths of an initial step, which its microsteps do not list. */
    readonly paths?: Paths
  }

  const nothing: Published = { event: undefined, microsteps: empty, emitted: empty, commands: empty }

  /** The logical state that a step reached, and what was built of it already. */
  interface Reached {
    readonly planning: Planning
    readonly execution: unknown
    readonly configuration: Configuration.ActiveConfiguration | undefined
    readonly snapshot: Machine.Snapshot<any> | undefined
    readonly runs: number
  }

  const reached = (
    planning: Planning,
    execution: unknown,
    configuration: Configuration.ActiveConfiguration | undefined,
    snapshot: Machine.Snapshot<any> | undefined,
    runs: number
  ): Reached => ({ planning, execution, configuration, snapshot, runs })

  /**
   * A machine that ends in a step stops all of its work. `next` is the state the
   * step reached, or the state before it when the step could not be applied.
   */
  const ended = (
    next: Reached,
    stop: ReadonlyArray<Work>,
    exit: Exit.Exit<unknown, unknown>,
    published: Published = nothing
  ): Step<O> =>
    new Step(
      new State<O>(next.planning, next.execution, next.configuration, next.snapshot, empty, next.runs, exit),
      published.event,
      published.microsteps,
      published.emitted,
      published.commands,
      stop,
      empty,
      published.paths
    )

  // A plan that throws leaves the state it received as it was, so the state
  // before a failed step is still the state that was passed in.
  const endedFrom = (state: State<O>): Reached => {
    const built = state.built
    return reached(state.planning, built.execution, built.configuration, state.snapshot, state.runs)
  }

  /**
   * Lists the work of the entered paths, one run per entry. Work that `progress`
   * names is not started: work that ended is left out, and work that still runs
   * is kept without being listed in `start`. Only a configuration that enters
   * an invoking state is built to resolve its work.
   */
  const enter = (
    next: Reached,
    entered: ReadonlyArray<readonly [ReadonlyArray<string>, Machine.LifecycleEvent<any>]>,
    kept: ReadonlyArray<Work>,
    stop: ReadonlyArray<Work>,
    published: Published,
    progress?: ReadonlyArray<Progress>
  ): Step<O> => {
    let configuration = next.configuration
    let runs = next.runs
    let start: Array<Work> | undefined
    // Every piece of work that runs after the entry, in start order: what
    // `progress` says still runs takes its place among the work that starts.
    let added: Array<Work> | undefined
    if (entered.some(([paths]) => paths.some((path) => invoking.has(path)))) {
      configuration ??= plan.toConfiguration(next.execution)
      for (
        const group of InvocationResolution.resolveEntries(machine, configuration, entered, next.planning.capabilities)
      ) {
        const run = runs++
        for (const invocation of group.invocations) {
          const status = progress?.find((entry) => entry.path === invocation.path && entry.id === invocation.id)
            ?.status
          if (status === "Ended") continue
          const work = describe(next.planning, invocation, run)
          ;(added ??= []).push(work)
          if (status !== "Running") (start ??= []).push(work)
        }
      }
    }
    const running = added === undefined ? kept : kept.length === 0 ? added : [...kept, ...added]
    return new Step(
      // An owned state keeps only what its host reads again: the configuration
      // is built again when a later step needs it.
      new State<O>(
        next.planning,
        next.execution,
        ownership === "Owned" ? undefined : configuration,
        next.snapshot,
        running,
        runs,
        undefined
      ),
      published.event,
      published.microsteps,
      published.emitted,
      published.commands,
      stop,
      start ?? empty,
      published.paths
    )
  }

  /**
   * Plans one event on a state that runs `running`: a public event that `send`
   * decoded, or the invocation event of a result.
   */
  const advance = (
    state: State<O>,
    running: ReadonlyArray<Work>,
    event: Machine.EventOf<any> | InvocationEvent.InvocationEvent,
    retain: boolean
  ): Step<O> => {
    let planned: ExecutionPlan.ExecutionMacrostep
    try {
      // A step publishes its microsteps, so a plan retains them unless its host reads none.
      planned = plan.planDecoded(state.execution, event, ownership, retain, state.planning)
    } catch (error) {
      // The step planned the event, as transitions receive it, and its planning failed.
      const planning = InvocationEvent.isInvocationEvent(event) ? InvocationEvent.toLifecycleEvent(event) : event
      return ended(endedFrom(state), latestFirst(running), exitOfThrow(error), { ...nothing, event: planning })
    }
    if (planned.microsteps.length === 0) {
      return new Step(
        running === state.running ? state : state.withRunning(running),
        planned.event,
        empty,
        empty,
        empty,
        empty,
        empty
      )
    }
    const commanded = planned.commands.length === 0 ? undefined : commandsOf(planned.commands, running)
    const commands = commanded === undefined ? empty : commanded.commands
    if (invoking.size === 0) {
      return planned.done
        ? ended(
          reached(state.planning, planned.next, undefined, undefined, state.runs),
          empty,
          Exit.succeed(planned.output),
          { event: planned.event, microsteps: planned.microsteps, emitted: planned.emittedEvents, commands }
        )
        : new Step(
          new State<O>(state.planning, planned.next, undefined, undefined, empty, state.runs, undefined),
          planned.event,
          planned.microsteps,
          planned.emittedEvents,
          commands,
          empty,
          empty
        )
    }
    const changes = InvocationChanges.fromMicrosteps(planned.microsteps)
    const published: Published = {
      event: planned.event,
      microsteps: planned.microsteps,
      emitted: planned.emittedEvents,
      commands
    }
    const next = reached(state.planning, planned.next, undefined, undefined, state.runs)
    const { kept, stop } = InvocationChanges.partition(commanded === undefined ? running : commanded.running, changes)
    if (planned.done) {
      return ended(next, [...stop, ...latestFirst(kept)], Exit.succeed(planned.output), published)
    }
    return enter(next, InvocationChanges.entries(changes), kept, stop, published)
  }

  /**
   * `work`, when `state` runs it and its result still applies. Work is compared
   * by identity: `path`, `id` and `run` repeat after a resume and across steps
   * taken from one kept state, and the object a step listed does not.
   */
  const current = (state: State<O>, work: Work): Work | undefined =>
    state.exit === undefined && state.running.includes(work) ? work : undefined

  // The planner reads currency from a generation handle. The state value has
  // decided it already, so each delivered event gets a fresh one.
  const generation = (): InvocationEvent.Generation => ({ current: true })

  /** The state a step starts in, from a configuration that the reference planner built. */
  const initial = (
    planning: Planning,
    configuration: Configuration.ActiveConfiguration,
    snapshot: Machine.Snapshot<any>
  ): Reached => reached(planning, plan.fromConfiguration(configuration), configuration, snapshot, 0)

  // Starting and resuming plan with the reference planner: they happen once per
  // machine, and their result enters the plan through `fromConfiguration`.
  const start: Kernel<O>["start"] = (planning, input, retain = true) => {
    // The execution plan starts a machine that it covers without publishing
    // microsteps: a host that reads none takes that start.
    if (!retain && plan.initial !== undefined) return startUnretained(planning, plan.initial, input)
    let planned: ReturnType<typeof Planner.planInitialSync>
    let configuration: Configuration.ActiveConfiguration
    try {
      planned = Planner.planInitialSync(Planner.withMachineReferences(machine, planning), ...input)
      configuration = Configuration.normalizeConfigurationSync(machine, planned.state)
    } catch (error) {
      return Exit.fail(toStartupFailure(error))
    }
    const published: Published = {
      event: Planner.InitialEvent,
      microsteps: planned.microsteps,
      emitted: planned.emittedEvents,
      commands: commandsOf(planned.commands, empty).commands,
      paths: {
        exited: empty,
        entered: Planner.sortEntryPaths(machine, Configuration.getInitialEntryPaths(machine, configuration))
      }
    }
    const next = initial(planning, configuration, planned.state)
    if (planned.done) {
      return Exit.succeed(ended(next, empty, Exit.succeed(planned.output), published))
    }
    return Exit.succeed(
      enter(next, InvocationResolution.initialEntries(machine, configuration), empty, empty, published)
    )
  }

  const startUnretained = (
    planning: Planning,
    initialOf: NonNullable<ExecutionPlan.CompiledExecutionPlan["initial"]>,
    input: ReadonlyArray<unknown>
  ): Exit.Exit<Step<O>, unknown> => {
    let planned: ReturnType<typeof initialOf>
    try {
      planned = initialOf(input, planning)
    } catch (error) {
      return Exit.fail(toStartupFailure(error))
    }
    const configuration = planned.activeConfiguration
    const published: Published = {
      event: Planner.InitialEvent,
      microsteps: empty,
      emitted: empty,
      commands: empty,
      paths: { exited: empty, entered: Planner.sortEntryPaths(machine, planned.initialEntryPaths) }
    }
    const next = reached(planning, planned.configuration, configuration, planned.state, 0)
    if (planned.done) {
      return Exit.succeed(ended(next, empty, Exit.succeed(planned.output), published))
    }
    return Exit.succeed(
      enter(next, InvocationResolution.initialEntries(machine, configuration), empty, empty, published)
    )
  }

  const fromSnapshot: Kernel<O>["fromSnapshot"] = (planning, snapshot) => {
    if (invoking.size > 0) throw new Error("A machine that invokes work runs its work in its state")
    return new State<O>(planning, undefined, undefined, snapshot, empty, 0, undefined)
  }

  const send = (state: State<O>, event: unknown): Exit.Exit<Step<O>, unknown> => {
    if (state.exit !== undefined) return Exit.fail(new StoppedError())
    let decoded: Machine.EventOf<any>
    try {
      decoded = Protocol.decodeEventSync(machine, event)
    } catch (error) {
      // Only an event that its schema refuses is rejected. Any other throw is
      // a defect of the machine, as it is when the planner decodes the event.
      return error instanceof MachineSchemaDecodeError
        ? Exit.fail(error)
        : Exit.succeed(ended(endedFrom(state), latestFirst(state.running), Exit.die(error)))
    }
    return Exit.succeed(advance(state, state.running, decoded, true))
  }

  const sendDecoded = (state: State<O>, event: Machine.EventOf<any>, retain = true): Step<O> =>
    state.exit === undefined ? advance(state, state.running, event, retain) : unchanged(state)

  const settle = (state: State<O>, work: Work, exit: Exit.Exit<unknown, unknown>, retain = true): Step<O> => {
    const settled = current(state, work)
    if (settled === undefined) return unchanged(state)
    const running = state.running.filter((other) => other !== settled)
    const decision = InvocationOutcome.decide(settled[WorkTypeId], generation(), InvocationOutcome.fromExit(exit))
    switch (decision._tag) {
      case "Deliver":
        return advance(state, running, decision.event, retain)
      case "Fail":
        return ended(endedFrom(state), latestFirst(running), Exit.failCause(decision.cause))
      case "Ignore":
        return unchanged(state.withRunning(running))
    }
  }

  const element = (state: State<O>, work: Work, value: unknown, retain = true): Step<O> => {
    const streaming = current(state, work)
    if (streaming === undefined) return unchanged(state)
    const invocation = streaming[WorkTypeId]
    if (invocation._tag !== "Stream") return unchanged(state)
    const decision = InvocationOutcome.decideElement(invocation, generation(), value)
    return decision._tag === "Ignore" ? unchanged(state) : advance(state, state.running, decision.event, retain)
  }

  const report = (state: State<O>, work: Work, snapshot: unknown, retain = true): Step<O> => {
    const reporting = current(state, work)
    if (reporting === undefined) return unchanged(state)
    const invocation = reporting[WorkTypeId]
    if (invocation._tag !== "Logic" && invocation._tag !== "Child") return unchanged(state)
    // Owners read the state of an active process, as the local runtime reports it.
    const decision = InvocationOutcome.decideSnapshot(invocation, generation(), { status: "active", state: snapshot })
    return decision._tag === "Ignore" ? unchanged(state) : advance(state, state.running, decision.event, retain)
  }

  const stop = (state: State<O>): Step<O> =>
    state.exit === undefined
      ? ended(endedFrom(state), latestFirst(state.running), Exit.fail(new StoppedError()))
      : unchanged(state)

  const resume: Kernel<O>["resume"] = (planning, snapshot, progress) => {
    const normalized = Effect.runSyncExit(Serialization.normalizeSnapshotEffect(machine, snapshot))
    if (Exit.isFailure(normalized)) return Exit.failCause(normalized.cause)
    const state = normalized.value
    let configuration: Configuration.ActiveConfiguration
    try {
      configuration = Configuration.normalizeConfigurationSync(machine, state)
    } catch (error) {
      return exitOfThrow(error)
    }
    const published: Published = { ...nothing, event: Planner.InitialEvent }
    const next = initial(planning, configuration, state)
    if (!Planner.isFinalState(machine, state)) {
      return Exit.succeed(
        enter(next, InvocationResolution.initialEntries(machine, configuration), empty, empty, published, progress)
      )
    }
    const output = Effect.runSyncExit(Planner.getFinalOutputEffect(machine, state, Planner.InitialEvent))
    return Exit.isFailure(output)
      ? Exit.failCause(output.cause)
      : Exit.succeed(ended(next, empty, Exit.succeed(output.value), published))
  }

  if (ownership === "Persistent") {
    return { plan, start, fromSnapshot, rest: (state) => state.resting(), send, sendDecoded, settle, element, report, stop, resume }
  }
  // An owned state is taken over by the step it is passed to, and handed back
  // when the step returns that very state, or refuses the event.
  return {
    plan,
    start,
    fromSnapshot,
    rest: (state) => state.handOverNeverReuse().resting(),
    send: (state, event) => {
      const exit = send(state.handOverNeverReuse(), event)
      if (Exit.isFailure(exit) || exit.value.state === state) state.giveBackUnchanged()
      return exit
    },
    sendDecoded: (state, event, retain) =>
      givenBackIfUnchanged(state, sendDecoded(state.handOverNeverReuse(), event, retain)),
    settle: (state, work, exit, retain) =>
      givenBackIfUnchanged(state, settle(state.handOverNeverReuse(), work, exit, retain)),
    element: (state, work, value, retain) =>
      givenBackIfUnchanged(state, element(state.handOverNeverReuse(), work, value, retain)),
    report: (state, work, snapshot, retain) =>
      givenBackIfUnchanged(state, report(state.handOverNeverReuse(), work, snapshot, retain)),
    stop: (state) => givenBackIfUnchanged(state, stop(state.handOverNeverReuse())),
    resume
  }
}

Object.defineProperty(State.prototype, StateTypeId, { value: StateTypeId })

/** Gives an owned state back to the caller of a step that returned it unchanged. */
const givenBackIfUnchanged = <O extends Ownership>(state: State<O>, step: Step<O>): Step<O> => {
  if (step.state === state) state.giveBackUnchanged()
  return step
}

type PlannerKind = "Compiled" | "Reference"

const kernels = {
  Persistent: { Compiled: new WeakMap(), Reference: new WeakMap() },
  Owned: { Compiled: new WeakMap(), Reference: new WeakMap() }
} satisfies Record<Ownership, Record<PlannerKind, WeakMap<Machine.Any, Kernel<any>>>>

/**
 * The step functions of `machine` that take states of `ownership` and plan
 * with `planner`: the execution plan of the machine, which `compileExecutionPlan`
 * selects, or always the reference planner. They are built once per machine.
 *
 * @internal
 */
export const kernel = <O extends Ownership>(machine: Machine.Any, ownership: O, planner: PlannerKind): Kernel<O> => {
  const cache = kernels[ownership][planner] as WeakMap<Machine.Any, Kernel<O>>
  let built = cache.get(machine)
  if (built === undefined) {
    built = build(
      machine,
      ownership,
      planner === "Compiled"
        ? ExecutionPlan.compileExecutionPlan(machine)
        : ExecutionPlan.selectExecutionPlanForTesting(machine, "generic").plan
    )
    cache.set(machine, built)
  }
  return built
}

/** The step functions of `kernel`, bound to one host. */
const bind = <O extends Ownership>(machine: Machine.Any, kernel: Kernel<O>, options: Options): MachineStep<O> => {
  const planning = new Planning(
    machine,
    kernel.plan,
    options.self,
    options.parent,
    options.children ?? refusedChildren
  )
  return {
    start: (...input) => kernel.start(planning, input),
    send: kernel.send,
    sendDecoded: kernel.sendDecoded,
    settle: kernel.settle,
    element: kernel.element,
    report: kernel.report,
    stop: kernel.stop,
    resume: (snapshot, progress) => kernel.resume(planning, snapshot, progress)
  }
}

/**
 * The step functions of `Machine.toStep`, which take immutable state values.
 *
 * @internal
 */
export const make = (machine: Machine.Any, options: Options): MachineStep<"Persistent"> =>
  bind(machine, kernel(machine, "Persistent", "Compiled"), options)

/**
 * Step functions that take each state over and may update it in place, for a
 * host that keeps only its latest state. The caller never uses a state again
 * after it passes it to one of them, nor any step that returned it. See
 * {@link Ownership}.
 *
 * @internal
 */
export const makeOwned = (machine: Machine.Any, options: Options): OwnedMachineStep =>
  bind(machine, kernel(machine, "Owned", "Compiled"), options)

/**
 * Step functions of either ownership that plan with the planner of `planner`:
 * the execution plan of the machine, as `make` and `makeOwned` use, or always
 * the reference planner.
 *
 * @internal
 */
export const makeForTesting = <O extends Ownership>(
  machine: Machine.Any,
  options: Options,
  ownership: O,
  planner: PlannerKind
): MachineStep<O> => bind(machine, kernel(machine, ownership, planner), options)
