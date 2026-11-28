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
import * as Exit from "effect/Exit"
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
    readonly duration: () => Exit.Exit<Exit.Exit<Duration.Duration>>
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

/** The machine of a step function, and the plan it steps with. */
interface Planning {
  readonly machine: Machine.Any
  readonly plan: ExecutionPlan.CompiledExecutionPlan
}

const empty: ReadonlyArray<never> = []

/**
 * The host state. `execution` is the execution state of the plan, which
 * carries no machine references: they are attached for each plan, as the local
 * runtime attaches them. The configuration and the public snapshot are built
 * from it on first read.
 *
 * A `"Persistent"` state never changes after it is built. The `execution` of
 * an `"Owned"` state is written in place by the step that it is handed over to,
 * and so is everything read from it that was not read before.
 *
 * @internal
 */
export class State<O extends Ownership = "Persistent"> {
  readonly [StateTypeId]: typeof StateTypeId = StateTypeId
  declare readonly [OwnershipTypeId]: O
  #configuration: Configuration.ActiveConfiguration | undefined
  #snapshot: Machine.Snapshot<any> | undefined
  /** Whether an owned state was handed over to a step, which may have written it. */
  #handedOver = false

  constructor(
    readonly planning: Planning,
    readonly execution: unknown,
    configuration: Configuration.ActiveConfiguration | undefined,
    snapshot: Machine.Snapshot<any> | undefined,
    /** The work that runs, in start order. */
    readonly running: ReadonlyArray<Work>,
    /** How many entries of invoking states have begun: the run of the next one. */
    readonly runs: number,
    readonly exit: Exit.Exit<unknown, unknown> | undefined
  ) {
    this.#configuration = configuration
    this.#snapshot = snapshot
  }

  get machine(): Machine.Any {
    return this.planning.machine
  }

  get configuration(): Configuration.ActiveConfiguration {
    return this.#configuration ??= this.planning.plan.toConfiguration(this.execution)
  }

  get snapshot(): Machine.Snapshot<any> {
    return this.#snapshot ??= this.planning.plan.snapshot(this.execution)
  }

  /** This state with other running work, keeping what was read of it. */
  withRunning(running: ReadonlyArray<Work>): State<O> {
    return new State(this.planning, this.execution, this.#configuration, this.#snapshot, running, this.runs, this.exit)
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

/**
 * What one step did. Its microsteps are made public on first read.
 *
 * @internal
 */
export class Step<O extends Ownership = "Persistent"> {
  #microsteps: ReadonlyArray<PlannedMicrostep> | undefined
  #published: ReadonlyArray<PublishedMicrostep> | undefined

  constructor(
    readonly state: State<O>,
    readonly event: unknown,
    microsteps: ReadonlyArray<PlannedMicrostep>,
    readonly emitted: ReadonlyArray<unknown>,
    readonly commands: ReadonlyArray<Command>,
    readonly stop: ReadonlyArray<Work>,
    readonly start: ReadonlyArray<Work>
  ) {
    this.#microsteps = microsteps
  }

  get snapshot(): Machine.Snapshot<any> {
    return this.state.snapshot
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

/** @internal */
export const isState = (value: unknown): value is State<Ownership> => value instanceof State

const unchanged = <O extends Ownership>(state: State<O>): Step<O> =>
  new Step(state, undefined, empty, empty, empty, empty, empty)

/** A planning throw: typed for the planner's own errors, a defect otherwise. */
const exitOfThrow = (error: unknown): Exit.Exit<never, unknown> =>
  isPlanningError(error) ? Exit.fail(error) : Exit.die(error)

/** The work that runs in a state, latest first, as a host stops it when its machine ends. */
const latestFirst = (running: ReadonlyArray<Work>): ReadonlyArray<Work> =>
  running.length < 2 ? running : running.slice().reverse()

/** Calls user code once, and keeps its result or its throw. */
const once = <A>(evaluate: () => A): () => Exit.Exit<A> => {
  let result: Exit.Exit<A> | undefined
  return () => {
    if (result === undefined) {
      try {
        result = Exit.succeed(evaluate())
      } catch (error) {
        result = Exit.die(error)
      }
    }
    return result
  }
}

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
  options: Options,
  ownership: O,
  plan: ExecutionPlan.CompiledExecutionPlan
): MachineStep<O> => {
  const planning: Planning = { machine, plan }
  // A machine that invokes no work runs none, so its steps track none.
  const invoking = invokingPaths(machine)
  const references: Configuration.PlanningMachineReferences = { self: options.self, parent: options.parent }
  const initialMachine = Planner.withMachineReferences(machine, references)
  const children = options.children ?? refusedChildren
  const capabilities: InvocationResolution.InvocationCapabilities = {
    self: options.self,
    parent: options.parent,
    children: childOwnerOf(children)
  }
  // Work acts on the children of this machine through the services of its host.
  const services = servicesOf(children)
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, unknown> =>
    Effect.updateContext(effect, (context: Context.Context<unknown>) => Context.merge(context, services))

  const scopedLogic = (logic: AnyLogic): AnyLogic => {
    const scoped = LogicScope.scoped(logic)
    return {
      initial: (context) => provide(scoped.initial(context)),
      run: (context) => provide(scoped.run(context))
    }
  }

  /** Describes one invocation, without calling any of its user code. */
  const describe = (invocation: InvocationResolution.ResolvedInvocation, run: number): Work => {
    const base = { [WorkTypeId]: invocation, path: invocation.path, id: invocation.id, run }
    switch (invocation._tag) {
      case "Effect":
        return {
          ...base,
          _tag: "Effect",
          source: invocation.sourceName,
          // Each run owns a scope, closed with its exit, as on the local runtime.
          effect: once(() => provide(Effect.scoped(invocation.effect())))
        }
      case "Timer": {
        const duration = once(invocation.duration)
        return {
          ...base,
          _tag: "Timer",
          source: invocation.sourceName,
          duration,
          effect: () => Exit.map(duration(), (wait) => Effect.flatMap(wait, Effect.sleep))
        }
      }
      case "Stream":
        return {
          ...base,
          _tag: "Stream",
          source: invocation.sourceName,
          // A run of a Stream owns a scope too, closed with its end or its stop.
          stream: once(() =>
            Stream.updateContext(
              Stream.scoped(invocation.stream()),
              (context: Context.Context<unknown>) => Context.merge(context, services)
            )
          )
        }
      case "Logic":
        return {
          ...base,
          _tag: "Logic",
          source: invocation.sourceName,
          address: invocation.address,
          logic: once(() => scopedLogic(invocation.logic()))
        }
      case "Child": {
        const input = invocation.input
        return {
          ...base,
          _tag: "Child",
          source: undefined,
          child: invocation.child,
          input: once(() => input === undefined ? empty : [input()])
        }
      }
    }
  }

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
  }

  const nothing: Published = { event: undefined, microsteps: empty, emitted: empty, commands: empty }

  /** The logical state that a step reached, and what was built of it already. */
  interface Reached {
    readonly execution: unknown
    readonly configuration: Configuration.ActiveConfiguration | undefined
    readonly snapshot: Machine.Snapshot<any> | undefined
    readonly runs: number
  }

  const reached = (
    execution: unknown,
    configuration: Configuration.ActiveConfiguration | undefined,
    snapshot: Machine.Snapshot<any> | undefined,
    runs: number
  ): Reached => ({ execution, configuration, snapshot, runs })

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
      new State<O>(planning, next.execution, next.configuration, next.snapshot, empty, next.runs, exit),
      published.event,
      published.microsteps,
      published.emitted,
      published.commands,
      stop,
      empty
    )

  // A plan that throws leaves the state it received as it was, so the state
  // before a failed step is still the state that was passed in.
  const endedFrom = (state: State<O>): Reached =>
    reached(state.execution, state.configuration, state.snapshot, state.runs)

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
      for (const group of InvocationResolution.resolveEntries(machine, configuration, entered, capabilities)) {
        const run = runs++
        for (const invocation of group.invocations) {
          const status = progress?.find((entry) => entry.path === invocation.path && entry.id === invocation.id)
            ?.status
          if (status === "Ended") continue
          const work = describe(invocation, run)
          ;(added ??= []).push(work)
          if (status !== "Running") (start ??= []).push(work)
        }
      }
    }
    const running = added === undefined ? kept : kept.length === 0 ? added : [...kept, ...added]
    return new Step(
      new State<O>(planning, next.execution, configuration, next.snapshot, running, runs, undefined),
      published.event,
      published.microsteps,
      published.emitted,
      published.commands,
      stop,
      start ?? empty
    )
  }

  /**
   * Plans one event on a state that runs `running`: a public event that `send`
   * decoded, or the invocation event of a result.
   */
  const advance = (
    state: State<O>,
    running: ReadonlyArray<Work>,
    event: Machine.EventOf<any> | InvocationEvent.InvocationEvent
  ): Step<O> => {
    let planned: ExecutionPlan.ExecutionMacrostep
    try {
      // A step publishes its microsteps, so every plan retains them.
      planned = plan.planDecoded(state.execution, event, ownership, true, references)
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
          reached(planned.next, undefined, undefined, state.runs),
          empty,
          Exit.succeed(planned.output),
          { event: planned.event, microsteps: planned.microsteps, emitted: planned.emittedEvents, commands }
        )
        : new Step(
          new State<O>(planning, planned.next, undefined, undefined, empty, state.runs, undefined),
          planned.event,
          planned.microsteps,
          planned.emittedEvents,
          commands,
          empty,
          empty
        )
    }
    const published: Published = {
      event: planned.event,
      microsteps: planned.microsteps,
      emitted: planned.emittedEvents,
      commands
    }
    const next = reached(planned.next, undefined, undefined, state.runs)
    const changes = InvocationChanges.fromMicrosteps(planned.microsteps)
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
    configuration: Configuration.ActiveConfiguration,
    snapshot: Machine.Snapshot<any>
  ): Reached => reached(plan.fromConfiguration(configuration), configuration, snapshot, 0)

  // Starting and resuming plan with the reference planner: they happen once per
  // machine, and their result enters the plan through `fromConfiguration`.
  const start: MachineStep<O>["start"] = (...input) => {
    let planned: ReturnType<typeof Planner.planInitialSync>
    let configuration: Configuration.ActiveConfiguration
    try {
      planned = Planner.planInitialSync(initialMachine, ...input)
      configuration = Configuration.normalizeConfigurationSync(machine, planned.state)
    } catch (error) {
      return Exit.fail(toStartupFailure(error))
    }
    const published: Published = {
      event: Planner.InitialEvent,
      microsteps: planned.microsteps,
      emitted: planned.emittedEvents,
      commands: commandsOf(planned.commands, empty).commands
    }
    const next = initial(configuration, planned.state)
    if (planned.done) {
      return Exit.succeed(ended(next, empty, Exit.succeed(planned.output), published))
    }
    return Exit.succeed(
      enter(next, InvocationResolution.initialEntries(machine, configuration), empty, empty, published)
    )
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
    return Exit.succeed(advance(state, state.running, decoded))
  }

  const settle = (state: State<O>, work: Work, exit: Exit.Exit<unknown, unknown>): Step<O> => {
    const settled = current(state, work)
    if (settled === undefined) return unchanged(state)
    const running = state.running.filter((other) => other !== settled)
    const decision = InvocationOutcome.decide(settled[WorkTypeId], generation(), InvocationOutcome.fromExit(exit))
    switch (decision._tag) {
      case "Deliver":
        return advance(state, running, decision.event)
      case "Fail":
        return ended(endedFrom(state), latestFirst(running), Exit.failCause(decision.cause))
      case "Ignore":
        return unchanged(state.withRunning(running))
    }
  }

  const element = (state: State<O>, work: Work, value: unknown): Step<O> => {
    const streaming = current(state, work)
    if (streaming === undefined) return unchanged(state)
    const invocation = streaming[WorkTypeId]
    if (invocation._tag !== "Stream") return unchanged(state)
    const decision = InvocationOutcome.decideElement(invocation, generation(), value)
    return decision._tag === "Ignore" ? unchanged(state) : advance(state, state.running, decision.event)
  }

  const report = (state: State<O>, work: Work, snapshot: unknown): Step<O> => {
    const reporting = current(state, work)
    if (reporting === undefined) return unchanged(state)
    const invocation = reporting[WorkTypeId]
    if (invocation._tag !== "Logic" && invocation._tag !== "Child") return unchanged(state)
    // Owners read the state of an active process, as the local runtime reports it.
    const decision = InvocationOutcome.decideSnapshot(invocation, generation(), { status: "active", state: snapshot })
    return decision._tag === "Ignore" ? unchanged(state) : advance(state, state.running, decision.event)
  }

  const stop = (state: State<O>): Step<O> =>
    state.exit === undefined
      ? ended(endedFrom(state), latestFirst(state.running), Exit.fail(new StoppedError()))
      : unchanged(state)

  const resume: MachineStep<O>["resume"] = (snapshot, progress) => {
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
    const next = initial(configuration, state)
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
    return { start, send, settle, element, report, stop, resume }
  }
  // An owned state is taken over by the step it is passed to, and handed back
  // when the step returns that very state, or refuses the event.
  return {
    start,
    send: (state, event) => {
      const exit = send(state.handOverNeverReuse(), event)
      if (Exit.isFailure(exit) || exit.value.state === state) state.giveBackUnchanged()
      return exit
    },
    settle: (state, work, exit) => givenBackIfUnchanged(state, settle(state.handOverNeverReuse(), work, exit)),
    element: (state, work, value) => givenBackIfUnchanged(state, element(state.handOverNeverReuse(), work, value)),
    report: (state, work, snapshot) => givenBackIfUnchanged(state, report(state.handOverNeverReuse(), work, snapshot)),
    stop: (state) => givenBackIfUnchanged(state, stop(state.handOverNeverReuse())),
    resume
  }
}

/** Gives an owned state back to the caller of a step that returned it unchanged. */
const givenBackIfUnchanged = <O extends Ownership>(state: State<O>, step: Step<O>): Step<O> => {
  if (step.state === state) state.giveBackUnchanged()
  return step
}

/**
 * The step functions of `Machine.toStep`, which take immutable state values.
 *
 * @internal
 */
export const make = (machine: Machine.Any, options: Options): MachineStep<"Persistent"> =>
  build(machine, options, "Persistent", ExecutionPlan.compileExecutionPlan(machine))

/**
 * Step functions that take each state over and may update it in place, for a
 * host that keeps only its latest state. The caller never uses a state again
 * after it passes it to one of them, nor any step that returned it. See
 * {@link Ownership}.
 *
 * @internal
 */
export const makeOwned = (machine: Machine.Any, options: Options): OwnedMachineStep =>
  build(machine, options, "Owned", ExecutionPlan.compileExecutionPlan(machine))

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
  planner: "Compiled" | "Reference"
): MachineStep<O> =>
  build(
    machine,
    options,
    ownership,
    planner === "Compiled"
      ? ExecutionPlan.compileExecutionPlan(machine)
      : ExecutionPlan.selectExecutionPlanForTesting(machine, "generic").plan
  )
