/**
 * The pure form of a machine: what its next state is, and which work a host
 * starts and stops, for hosts written outside the local runtime.
 *
 * Every function is synchronous and returns a value. The host state is an
 * immutable value: it holds the configuration, the work that runs, and how many
 * entries of invoking states have begun, so the current run of each piece of
 * work is read from the state that a caller passes back, and never from a
 * handle shared with the caller.
 *
 * The order is the one of the generic runtime in `process.ts`: commands, the
 * work of exited states, the new state, emitted events, and the work of entered
 * states. Sources are evaluated in the step that enters their state.
 *
 * @since 0.48.0
 */

import * as Cause from "effect/Cause"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Stream from "effect/Stream"
import type { ChildOwner, Machine, MachineTarget } from "../../Machine.js"
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
import type * as InvocationEvent from "./invocationEvent.js"
import * as InvocationOutcome from "./invocationOutcome.js"
import * as InvocationResolution from "./invocationResolution.js"
import * as Planner from "./planner.js"
import * as Protocol from "./protocol.js"
import * as Serialization from "./serialization.js"

/** @internal */
export const StateTypeId: unique symbol = Symbol.for("effect/Machine/MachineStep/State")

/** @internal */
export const WorkTypeId: unique symbol = Symbol.for("effect/Machine/MachineStep/Work")

/** Invocations a step describes completely. */
type Described =
  | InvocationResolution.EffectInvocation
  | InvocationResolution.TimerInvocation
  | InvocationResolution.StreamInvocation

interface WorkBase {
  readonly [WorkTypeId]: Described
  readonly path: string
  readonly id: string
  readonly source: string | undefined
  readonly run: number
}

/** @internal */
export type Work =
  | WorkBase & { readonly _tag: "Effect"; readonly effect: Effect.Effect<unknown, unknown, unknown> }
  | WorkBase & { readonly _tag: "Timer"; readonly duration: Duration.Duration }
  | WorkBase & { readonly _tag: "Stream"; readonly stream: Stream.Stream<unknown, unknown, unknown> }

/** @internal */
export interface Send {
  readonly target: MachineTarget<unknown>
  readonly event: unknown
}

/**
 * The host state. `configuration` carries no machine references: they are
 * attached for each plan, as the local runtime attaches them.
 *
 * @internal
 */
export interface State {
  readonly [StateTypeId]: typeof StateTypeId
  readonly configuration: Configuration.ActiveConfiguration
  readonly snapshot: Machine.Snapshot<any>
  /** The work that runs, in start order. */
  readonly running: ReadonlyArray<Work>
  /** How many entries of invoking states have begun: the run of the next one. */
  readonly runs: number
  readonly exit: Exit.Exit<unknown, unknown> | undefined
}

/** @internal */
export interface Step {
  readonly state: State
  readonly snapshot: Machine.Snapshot<any>
  readonly emitted: ReadonlyArray<unknown>
  readonly sends: ReadonlyArray<Send>
  readonly stop: ReadonlyArray<Work>
  readonly start: ReadonlyArray<Work>
  readonly exit: Exit.Exit<unknown, unknown> | undefined
}

/** @internal */
export interface MachineStep {
  readonly start: (...input: ReadonlyArray<unknown>) => Exit.Exit<Step, unknown>
  readonly send: (state: State, event: unknown) => Exit.Exit<Step, unknown>
  readonly settle: (state: State, work: Work, exit: Exit.Exit<unknown, unknown>) => Step
  readonly element: (state: State, work: Work, element: unknown) => Step
  readonly stop: (state: State) => Step
  readonly resume: (snapshot: Machine.Snapshot<any>) => Exit.Exit<Step, unknown>
}

const empty: ReadonlyArray<never> = []

// Input mappers are synchronous, and the work they build runs on a host that
// owns no children, as on Cluster.
const refuse = (operation: string): Effect.Effect<never> => Effect.die(new ProcessLocalError({ operation }))

const refusedChildren: ChildOwner<any> = {
  spawn: () => refuse("children.spawn"),
  sendTo: () => refuse("children.sendTo"),
  stop: () => refuse("children.stop")
}

const makeState = (
  configuration: Configuration.ActiveConfiguration,
  snapshot: Machine.Snapshot<any>,
  running: ReadonlyArray<Work>,
  runs: number,
  exit: Exit.Exit<unknown, unknown> | undefined
): State => ({ [StateTypeId]: StateTypeId, configuration, snapshot, running, runs, exit })

/** @internal */
export const isState = (value: unknown): value is State =>
  typeof value === "object" && value !== null && StateTypeId in value

const unchanged = (state: State): Step => ({
  state,
  snapshot: state.snapshot,
  emitted: empty,
  sends: empty,
  stop: empty,
  start: empty,
  exit: state.exit
})

/** A planning throw: typed for the planner's own errors, a defect otherwise. */
const exitOfThrow = (error: unknown): Exit.Exit<never, unknown> =>
  isPlanningError(error) ? Exit.fail(error) : Exit.die(error)

const sameWork = (left: Work, right: Work): boolean =>
  left.run === right.run && left.path === right.path && left.id === right.id && left._tag === right._tag

/** The work that runs in a state, latest first, as a host stops it when its machine ends. */
const latestFirst = (running: ReadonlyArray<Work>): ReadonlyArray<Work> =>
  running.length < 2 ? running : running.slice().reverse()

/**
 * A machine that ends in a step stops all of its work. `next` is the state the
 * step reached, or the state before it when the step could not be applied.
 */
const ended = (
  next: {
    readonly configuration: Configuration.ActiveConfiguration
    readonly snapshot: Machine.Snapshot<any>
    readonly runs: number
  },
  stop: ReadonlyArray<Work>,
  exit: Exit.Exit<unknown, unknown>,
  published: { readonly emitted: ReadonlyArray<unknown>; readonly sends: ReadonlyArray<Send> } = {
    emitted: empty,
    sends: empty
  }
): Step => ({
  state: makeState(next.configuration, next.snapshot, empty, next.runs, exit),
  snapshot: next.snapshot,
  emitted: published.emitted,
  sends: published.sends,
  stop,
  start: empty,
  exit
})

/**
 * Commands of a transition, as data. A host of this module owns no children,
 * so a command addressed to one cannot be carried out.
 */
const toSends = (commands: ReadonlyArray<RuntimeCommand>): ReadonlyArray<Send> => {
  if (commands.length === 0) return empty
  const sends: Array<Send> = []
  for (const command of commands) {
    if (command._tag === "Stop") throw new ProcessLocalError({ operation: "enqueue.stop" })
    const target = command.target
    if (typeof target !== "object" || target === null || isChildMachine(target)) {
      throw new ProcessLocalError({ operation: "enqueue.sendTo" })
    }
    sends.push({ target, event: command.event })
  }
  return sends
}

/** Why the work of an entered state cannot start. */
interface Unstartable {
  readonly cause: Cause.Cause<unknown>
}

/**
 * Evaluates the source of one invocation, as the local runtime does when it
 * starts it. A source that throws, and a timer whose input names no duration,
 * fail the machine in the step that enters the state.
 */
const describe = (invocation: InvocationResolution.ResolvedInvocation, run: number): Work | Unstartable => {
  const base = { path: invocation.path, id: invocation.id, run }
  try {
    switch (invocation._tag) {
      case "Effect":
        return {
          [WorkTypeId]: invocation,
          _tag: "Effect",
          ...base,
          source: invocation.sourceName,
          // Each run owns a scope, closed with its exit, as on the local runtime.
          effect: Effect.scoped(invocation.effect())
        }
      case "Timer": {
        const duration = invocation.duration()
        return Exit.isFailure(duration)
          ? { cause: duration.cause }
          : {
            [WorkTypeId]: invocation,
            _tag: "Timer",
            ...base,
            source: invocation.sourceName,
            duration: duration.value
          }
      }
      case "Stream":
        return {
          [WorkTypeId]: invocation,
          _tag: "Stream",
          ...base,
          source: invocation.sourceName,
          // A run of a Stream owns a scope too, closed with its end or its stop.
          stream: Stream.scoped(invocation.stream())
        }
      case "Logic":
      case "Child":
        // The public signature refuses such machines. An erased one fails here.
        return { cause: Cause.die(new ProcessLocalError({ operation: `invoke ${invocation._tag}` })) }
    }
  } catch (error) {
    return { cause: Cause.die(error) }
  }
}

const isWork = (described: Work | Unstartable): described is Work => WorkTypeId in described

/** @internal */
export const make = (
  machine: Machine.Any,
  options: { readonly self: MachineTarget<any> }
): MachineStep => {
  const references: Configuration.PlanningMachineReferences = { self: options.self, parent: undefined }
  const initialMachine = Planner.withMachineReferences(machine, references)
  const capabilities: InvocationResolution.InvocationCapabilities = {
    self: options.self,
    parent: undefined,
    children: refusedChildren
  }

  /**
   * Starts the work of the entered paths, one run per entry, and fails the
   * machine when a source cannot be evaluated.
   */
  const enter = (
    configuration: Configuration.ActiveConfiguration,
    snapshot: Machine.Snapshot<any>,
    entered: Iterable<readonly [ReadonlyArray<string>, Machine.LifecycleEvent<any>]>,
    kept: ReadonlyArray<Work>,
    stop: ReadonlyArray<Work>,
    runs: number,
    published: { readonly emitted: ReadonlyArray<unknown>; readonly sends: ReadonlyArray<Send> }
  ): Step => {
    let start: Array<Work> | undefined
    for (const [paths, event] of entered) {
      for (const group of InvocationResolution.resolve(machine, configuration, paths, event, capabilities)) {
        const run = runs++
        for (const invocation of group.invocations) {
          const work = describe(invocation, run)
          if (!isWork(work)) {
            // Nothing of this step starts, and everything that ran stops.
            return ended(
              { configuration, snapshot, runs },
              [...stop, ...latestFirst(kept)],
              Exit.failCause(work.cause),
              published
            )
          }
          ;(start ??= []).push(work)
        }
      }
    }
    const running = start === undefined ? kept : [...kept, ...start]
    return {
      state: makeState(configuration, snapshot, running, runs, undefined),
      snapshot,
      emitted: published.emitted,
      sends: published.sends,
      stop,
      start: start ?? empty,
      exit: undefined
    }
  }

  /** Plans one event on a state that runs `running`. */
  const advance = (state: State, running: ReadonlyArray<Work>, event: unknown): Step => {
    let planned: ReturnType<typeof Planner.planConfiguration>
    let sends: ReadonlyArray<Send>
    try {
      planned = Planner.planConfiguration(
        machine,
        Configuration.withMachineReferences(state.configuration, references),
        event as Machine.EventOf<any>
      )
      sends = toSends(planned.commands)
    } catch (error) {
      return ended(state, latestFirst(running), exitOfThrow(error))
    }
    if (planned.microsteps.length === 0) {
      return running === state.running
        ? unchanged(state)
        : unchanged(makeState(state.configuration, state.snapshot, running, state.runs, state.exit))
    }
    const configuration = planned.next
    const snapshot = Configuration.snapshotFromConfiguration(machine, configuration)
    const published = { emitted: planned.emittedEvents, sends }
    const changes = InvocationChanges.fromMicrosteps(planned.microsteps)
    let stop: ReadonlyArray<Work> = empty
    let kept = running
    if (changes !== undefined && running.length > 0) {
      const exited: Array<Work> = []
      for (const path of new Set(changes.exited)) {
        for (const work of running) if (work.path === path) exited.push(work)
      }
      if (exited.length > 0) {
        stop = exited
        kept = running.filter((work) => !exited.includes(work))
      }
    }
    if (planned.done) {
      return ended(
        { configuration, snapshot, runs: state.runs },
        [...stop, ...latestFirst(kept)],
        Exit.succeed(planned.output),
        published
      )
    }
    return enter(
      configuration,
      snapshot,
      changes === undefined ? empty : Array.from(changes.entered, ([path, event]) => [[path], event] as const),
      kept,
      stop,
      state.runs,
      published
    )
  }

  /** The work of the active states of a configuration a machine starts in. */
  const begin = (
    configuration: Configuration.ActiveConfiguration,
    snapshot: Machine.Snapshot<any>,
    published: { readonly emitted: ReadonlyArray<unknown>; readonly sends: ReadonlyArray<Send> }
  ): Step =>
    enter(
      configuration,
      snapshot,
      [[Configuration.getInitialEntryPaths(machine, configuration), Planner.InitialEvent]],
      empty,
      empty,
      0,
      published
    )

  /** The work in `state` that `work` names, when its result still applies. */
  const current = (state: State, work: Work): Work | undefined =>
    state.exit === undefined ? state.running.find((running) => sameWork(running, work)) : undefined

  // The planner reads currency from a generation handle. The state value has
  // decided it already, so each delivered event gets a fresh one.
  const generation = (): InvocationEvent.Generation => ({ current: true })

  const start: MachineStep["start"] = (...input) => {
    let planned: ReturnType<typeof Planner.planInitialSync>
    let configuration: Configuration.ActiveConfiguration
    let sends: ReadonlyArray<Send>
    try {
      planned = Planner.planInitialSync(initialMachine, ...input)
      configuration = Configuration.normalizeConfigurationSync(machine, planned.state)
      sends = toSends(planned.commands)
    } catch (error) {
      return Exit.fail(toStartupFailure(error))
    }
    const published = { emitted: planned.emittedEvents, sends }
    if (planned.done) {
      return Exit.succeed(
        ended({ configuration, snapshot: planned.state, runs: 0 }, empty, Exit.succeed(planned.output), published)
      )
    }
    return Exit.succeed(begin(configuration, planned.state, published))
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
        : Exit.succeed(ended(state, latestFirst(state.running), Exit.die(error)))
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
        return ended(state, latestFirst(running), Exit.failCause(decision.cause))
      case "Ignore":
        return unchanged(makeState(state.configuration, state.snapshot, running, state.runs, state.exit))
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

  const stop: MachineStep["stop"] = (state) =>
    state.exit === undefined
      ? ended(state, latestFirst(state.running), Exit.fail(new StoppedError()))
      : unchanged(state)

  const resume: MachineStep["resume"] = (snapshot) => {
    const normalized = Effect.runSyncExit(Serialization.normalizeSnapshotEffect(machine, snapshot))
    if (Exit.isFailure(normalized)) return Exit.failCause(normalized.cause)
    const state = normalized.value
    let configuration: Configuration.ActiveConfiguration
    try {
      configuration = Configuration.normalizeConfigurationSync(machine, state)
    } catch (error) {
      return exitOfThrow(error)
    }
    if (!Planner.isFinalState(machine, state)) {
      return Exit.succeed(begin(configuration, state, { emitted: empty, sends: empty }))
    }
    const output = Effect.runSyncExit(Planner.getFinalOutputEffect(machine, state, Planner.InitialEvent))
    return Exit.isFailure(output)
      ? Exit.failCause(output.cause)
      : Exit.succeed(ended({ configuration, snapshot: state, runs: 0 }, empty, Exit.succeed(output.value)))
  }

  return { start, send, settle, element, stop, resume }
}
