/**
 * The pure form of a machine: what its next state is, and which work a host
 * starts and stops, for hosts written outside the local runtime.
 *
 * Every function is synchronous and returns a value. The host state is an
 * immutable value: it holds the configuration, the work that runs, and how many
 * entries of invoking states have begun. Whether work is current is read from
 * the state that a caller passes back, and never from a handle shared with the
 * caller: work is current when that state lists the very object the caller
 * reports, so work of an earlier entry, of a step that was not kept, or of a
 * machine before it resumed, is never taken for the work that runs.
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

/** A microstep of the planner, whose state is a configuration or already a snapshot. */
type PlannedMicrostep = {
  readonly next: unknown
  readonly event: unknown
  readonly transitions: ReadonlyArray<unknown>
  readonly commands: ReadonlyArray<RuntimeCommand>
  readonly raisedEvents: ReadonlyArray<unknown>
  readonly emittedEvents: ReadonlyArray<unknown>
  readonly exitPaths: ReadonlyArray<string>
  readonly entryPaths: ReadonlyArray<string>
  readonly changed: boolean
}

const empty: ReadonlyArray<never> = []

/**
 * The host state. `configuration` carries no machine references: they are
 * attached for each plan, as the local runtime attaches them. The public
 * snapshot is built on first read, and the value never changes after that.
 *
 * @internal
 */
export class State {
  readonly [StateTypeId]: typeof StateTypeId = StateTypeId
  #snapshot: Machine.Snapshot<any> | undefined

  constructor(
    readonly machine: Machine.Any,
    readonly configuration: Configuration.ActiveConfiguration,
    snapshot: Machine.Snapshot<any> | undefined,
    /** The work that runs, in start order. */
    readonly running: ReadonlyArray<Work>,
    /** How many entries of invoking states have begun: the run of the next one. */
    readonly runs: number,
    readonly exit: Exit.Exit<unknown, unknown> | undefined
  ) {
    this.#snapshot = snapshot
  }

  get snapshot(): Machine.Snapshot<any> {
    return this.#snapshot ??= Configuration.snapshotFromConfiguration(this.machine, this.configuration)
  }
}

/**
 * What one step did. Its microsteps are made public on first read.
 *
 * @internal
 */
export class Step {
  #microsteps: ReadonlyArray<PlannedMicrostep> | undefined
  #published: ReadonlyArray<PlannedMicrostep> | undefined

  constructor(
    readonly state: State,
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

  get microsteps(): ReadonlyArray<PlannedMicrostep> {
    if (this.#published === undefined) {
      const machine = this.state.machine
      const planned = this.#microsteps!
      this.#microsteps = undefined
      // Initial planning has published its microsteps already.
      this.#published = planned.length === 0 || this.event === Planner.InitialEvent
        ? planned
        : planned.map((microstep) => ({
          ...microstep,
          next: Configuration.snapshotFromConfiguration(
            machine,
            microstep.next as Configuration.ActiveConfiguration
          )
        }))
    }
    return this.#published
  }
}

/** @internal */
export interface MachineStep {
  readonly start: (...input: ReadonlyArray<unknown>) => Exit.Exit<Step, unknown>
  readonly send: (state: State, event: unknown) => Exit.Exit<Step, unknown>
  readonly settle: (state: State, work: Work, exit: Exit.Exit<unknown, unknown>) => Step
  readonly element: (state: State, work: Work, element: unknown) => Step
  readonly report: (state: State, work: Work, snapshot: unknown) => Step
  readonly stop: (state: State) => Step
  readonly resume: (
    snapshot: Machine.Snapshot<any>,
    progress?: ReadonlyArray<Progress>
  ) => Exit.Exit<Step, unknown>
}

/** @internal */
export const isState = (value: unknown): value is State => value instanceof State

const unchanged = (state: State): Step => new Step(state, undefined, empty, empty, empty, empty, empty)

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

/** @internal */
export const make = (machine: Machine.Any, options: Options): MachineStep => {
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

  /**
   * A machine that ends in a step stops all of its work. `next` is the state the
   * step reached, or the state before it when the step could not be applied.
   */
  const ended = (
    next: {
      readonly configuration: Configuration.ActiveConfiguration
      readonly snapshot: Machine.Snapshot<any> | undefined
      readonly runs: number
    },
    stop: ReadonlyArray<Work>,
    exit: Exit.Exit<unknown, unknown>,
    published: Published = nothing
  ): Step =>
    new Step(
      new State(machine, next.configuration, next.snapshot, empty, next.runs, exit),
      published.event,
      published.microsteps,
      published.emitted,
      published.commands,
      stop,
      empty
    )

  const endedFrom = (state: State) => ({
    configuration: state.configuration,
    snapshot: state.snapshot,
    runs: state.runs
  })

  /**
   * Lists the work of the entered paths, one run per entry. Work that `progress`
   * names is not started: work that ended is left out, and work that still runs
   * is kept without being listed in `start`.
   */
  const enter = (
    configuration: Configuration.ActiveConfiguration,
    snapshot: Machine.Snapshot<any> | undefined,
    entered: Iterable<readonly [ReadonlyArray<string>, Machine.LifecycleEvent<any>]>,
    kept: ReadonlyArray<Work>,
    stop: ReadonlyArray<Work>,
    runs: number,
    published: Published,
    progress?: ReadonlyArray<Progress>
  ): Step => {
    let start: Array<Work> | undefined
    // Every piece of work that runs after the entry, in start order: what
    // `progress` says still runs takes its place among the work that starts.
    let added: Array<Work> | undefined
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
    const running = added === undefined ? kept : kept.length === 0 ? added : [...kept, ...added]
    return new Step(
      new State(machine, configuration, snapshot, running, runs, undefined),
      published.event,
      published.microsteps,
      published.emitted,
      published.commands,
      stop,
      start ?? empty
    )
  }

  /** Plans one event on a state that runs `running`. */
  const advance = (state: State, running: ReadonlyArray<Work>, event: unknown): Step => {
    let planned: ReturnType<typeof Planner.planConfiguration>
    try {
      planned = Planner.planConfiguration(
        machine,
        Configuration.withMachineReferences(state.configuration, references),
        event as Machine.EventOf<any>
      )
    } catch (error) {
      // The step planned the event, as transitions receive it, and its planning failed.
      const planning = InvocationEvent.isInvocationEvent(event) ? InvocationEvent.toLifecycleEvent(event) : event
      return ended(endedFrom(state), latestFirst(running), exitOfThrow(error), { ...nothing, event: planning })
    }
    if (planned.microsteps.length === 0) {
      const kept = running === state.running
        ? state
        : new State(machine, state.configuration, state.snapshot, running, state.runs, state.exit)
      return new Step(kept, planned.event, empty, empty, empty, empty, empty)
    }
    const configuration = planned.next
    const commanded = commandsOf(planned.commands, running)
    const published: Published = {
      event: planned.event,
      microsteps: planned.microsteps,
      emitted: planned.emittedEvents,
      commands: commanded.commands
    }
    const changes = InvocationChanges.fromMicrosteps(planned.microsteps)
    const { kept, stop } = InvocationChanges.partition(commanded.running, changes)
    if (planned.done) {
      return ended(
        { configuration, snapshot: undefined, runs: state.runs },
        [...stop, ...latestFirst(kept)],
        Exit.succeed(planned.output),
        published
      )
    }
    return enter(
      configuration,
      undefined,
      InvocationChanges.entries(changes),
      kept,
      stop,
      state.runs,
      published
    )
  }

  /**
   * `work`, when `state` runs it and its result still applies. Work is compared
   * by identity: `path`, `id` and `run` repeat after a resume and across steps
   * taken from one kept state, and the object a step listed does not.
   */
  const current = (state: State, work: Work): Work | undefined =>
    state.exit === undefined && state.running.includes(work) ? work : undefined

  // The planner reads currency from a generation handle. The state value has
  // decided it already, so each delivered event gets a fresh one.
  const generation = (): InvocationEvent.Generation => ({ current: true })

  const start: MachineStep["start"] = (...input) => {
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
    if (planned.done) {
      return Exit.succeed(
        ended({ configuration, snapshot: planned.state, runs: 0 }, empty, Exit.succeed(planned.output), published)
      )
    }
    return Exit.succeed(
      enter(
        configuration,
        planned.state,
        InvocationResolution.initialEntries(machine, configuration),
        empty,
        empty,
        0,
        published
      )
    )
  }

  const send: MachineStep["send"] = (state, event) => {
    if (state.exit !== undefined) return Exit.fail(new StoppedError())
    let decoded: unknown
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

  const settle: MachineStep["settle"] = (state, work, exit) => {
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
        return unchanged(new State(machine, state.configuration, state.snapshot, running, state.runs, state.exit))
    }
  }

  const element: MachineStep["element"] = (state, work, value) => {
    const streaming = current(state, work)
    if (streaming === undefined) return unchanged(state)
    const invocation = streaming[WorkTypeId]
    if (invocation._tag !== "Stream") return unchanged(state)
    const decision = InvocationOutcome.decideElement(invocation, generation(), value)
    return decision._tag === "Ignore" ? unchanged(state) : advance(state, state.running, decision.event)
  }

  const report: MachineStep["report"] = (state, work, snapshot) => {
    const reporting = current(state, work)
    if (reporting === undefined) return unchanged(state)
    const invocation = reporting[WorkTypeId]
    if (invocation._tag !== "Logic" && invocation._tag !== "Child") return unchanged(state)
    // Owners read the state of an active process, as the local runtime reports it.
    const decision = InvocationOutcome.decideSnapshot(invocation, generation(), { status: "active", state: snapshot })
    return decision._tag === "Ignore" ? unchanged(state) : advance(state, state.running, decision.event)
  }

  const stop: MachineStep["stop"] = (state) =>
    state.exit === undefined
      ? ended(endedFrom(state), latestFirst(state.running), Exit.fail(new StoppedError()))
      : unchanged(state)

  const resume: MachineStep["resume"] = (snapshot, progress) => {
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
    if (!Planner.isFinalState(machine, state)) {
      return Exit.succeed(
        enter(
          configuration,
          state,
          InvocationResolution.initialEntries(machine, configuration),
          empty,
          empty,
          0,
          published,
          progress
        )
      )
    }
    const output = Effect.runSyncExit(Planner.getFinalOutputEffect(machine, state, Planner.InitialEvent))
    return Exit.isFailure(output)
      ? Exit.failCause(output.cause)
      : Exit.succeed(ended({ configuration, snapshot: state, runs: 0 }, empty, Exit.succeed(output.value), published))
  }

  return { start, send, settle, element, report, stop, resume }
}
