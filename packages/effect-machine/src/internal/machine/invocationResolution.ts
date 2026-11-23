/**
 * Host-neutral resolution of the work owned by entered states.
 *
 * `resolve` answers which invocations a step starts, in which order, and what
 * each one is. It runs nothing. Starting the work, owning it, and returning its
 * outcomes to the planner belong to the host, such as the local runtime in
 * `invocation.ts`.
 *
 * A host must:
 *
 * - resolve against the configuration the step settled in, with the lifecycle
 *   event that last entered each path;
 * - stop the work and retire the generations of exited paths before it starts
 *   the work of entered ones;
 * - begin one generation for each returned group, through
 *   `InvocationGenerations`, and start the group's invocations in order;
 * - call each lazy source at most once per start, inside its own startup failure
 *   boundary, after the previous invocation has started;
 * - route everything the work reports through `InvocationOutcome` with the
 *   group's generation, and plan a delivered event in a later turn than the one
 *   that started the work.
 *
 * @since 0.47.2
 */

import * as Duration from "effect/Duration"
import type * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type * as Stream from "effect/Stream"
import type { ChildMachine, ChildOwner, Logic, Machine, MachineTarget } from "../../Machine.js"
import * as Configuration from "./configuration.js"
import * as InvocationDefinition from "./invocationDefinition.js"
import * as Planner from "./planner.js"

/**
 * Outcome channels an invocation declares a transition for.
 *
 * @internal
 */
export interface OutcomeChannels {
  readonly done: boolean
  readonly failure: boolean
  readonly element: boolean
  readonly snapshot: boolean
}

interface Base {
  /** Path of the state that owns the invocation. */
  readonly path: string
  /** Lifecycle id that routes the invocation's outcomes within its state. */
  readonly id: string
  readonly channels: OutcomeChannels
}

interface NamedBase extends Base {
  /** Name the source is registered with, when it has one. */
  readonly sourceName: string | undefined
}

/** @internal */
export interface EffectInvocation extends NamedBase {
  readonly _tag: "Effect"
  /** Constructs the effect with its input applied. */
  readonly effect: () => Effect.Effect<unknown, unknown, unknown>
}

/**
 * A timer completes with `undefined` once its duration has elapsed.
 *
 * `duration` is lazy because a parameterized timer runs its input mapper and
 * source function. A throw belongs to the host's startup boundary. An input that
 * does not name a duration is the failed `Exit`, which the host reports as the
 * timer's own outcome.
 *
 * @internal
 */
export interface TimerInvocation extends NamedBase {
  readonly _tag: "Timer"
  readonly duration: () => Exit.Exit<Duration.Duration>
}

/** @internal */
export interface StreamInvocation extends NamedBase {
  readonly _tag: "Stream"
  /** Constructs the stream with its input applied. */
  readonly stream: () => Stream.Stream<unknown, unknown, unknown>
}

/** @internal */
export interface LogicInvocation extends NamedBase {
  readonly _tag: "Logic"
  /** Caller-chosen address of the started process within its owner. */
  readonly address: string
  /** Constructs the logic with its input applied. */
  readonly logic: () => Logic<any, any, any, any, any>
}

/**
 * A child machine is named by its descriptor rather than by its source.
 *
 * @internal
 */
export interface ChildInvocation extends Base {
  readonly _tag: "Child"
  readonly child: ChildMachine.Any
  /** Constructs the child's input, or `undefined` when none is declared. */
  readonly input: (() => unknown) | undefined
}

/**
 * One invocation to start, described without any host capability.
 *
 * @internal
 */
export type ResolvedInvocation =
  | EffectInvocation
  | TimerInvocation
  | StreamInvocation
  | LogicInvocation
  | ChildInvocation

/**
 * The invocations started by one entry of a state, in start order. They share
 * one generation.
 *
 * @internal
 */
export interface InvocationGroup {
  readonly path: string
  readonly invocations: ReadonlyArray<ResolvedInvocation>
}

/**
 * Host capabilities exposed to input mappers.
 *
 * @internal
 */
export interface InvocationCapabilities {
  readonly self: MachineTarget<any>
  readonly parent?: MachineTarget<any> | undefined
  readonly children: ChildOwner<any>
}

const channelCombinations: ReadonlyArray<OutcomeChannels> = Array.from({ length: 16 }, (_, bits) =>
  Object.freeze({
    done: (bits & 1) !== 0,
    failure: (bits & 2) !== 0,
    element: (bits & 4) !== 0,
    snapshot: (bits & 8) !== 0
  }))

// Descriptions live as long as the work they start, so equal channels share one
// immutable value.
const outcomeChannels = (definition: InvocationDefinition.InvocationDefinition): OutcomeChannels =>
  channelCombinations[
    (definition.onDone === undefined ? 0 : 1) |
    (definition.onFailure === undefined ? 0 : 2) |
    (definition.onElement === undefined ? 0 : 4) |
    (definition.onSnapshot === undefined ? 0 : 8)
  ]!

const toDuration = (input: Duration.Input): Exit.Exit<Duration.Duration> => {
  try {
    return Exit.succeed(Duration.fromInputUnsafe(input))
  } catch (error) {
    return Exit.die(error)
  }
}

type ChildDefinition = Extract<InvocationDefinition.InvocationDefinition, { readonly child: ChildMachine.Any }>

// A child without input does not depend on its entry context, so neither
// building nor retaining one is worthwhile.
const resolveChild = (
  definition: ChildDefinition,
  path: string,
  input: (() => unknown) | undefined
): ChildInvocation => ({
  _tag: "Child",
  path,
  id: InvocationDefinition.lifecycleId(definition),
  channels: outcomeChannels(definition),
  child: definition.child,
  input
})

const resolveDefinition = (
  definition: InvocationDefinition.InvocationDefinition,
  path: string,
  context: InvocationDefinition.Context
): ResolvedInvocation => {
  const id = InvocationDefinition.lifecycleId(definition)
  const sourceName = definition.sourceName
  const channels = outcomeChannels(definition)
  if ("effect" in definition) {
    return { _tag: "Effect", path, id, sourceName, channels, effect: () => definition.effect(context) }
  }
  if ("after" in definition) {
    return {
      _tag: "Timer",
      path,
      id,
      sourceName,
      channels,
      duration: () => toDuration(typeof definition.after === "function" ? definition.after(context) : definition.after)
    }
  }
  if ("stream" in definition) {
    return { _tag: "Stream", path, id, sourceName, channels, stream: () => definition.stream(context) }
  }
  if ("logic" in definition) {
    return {
      _tag: "Logic",
      path,
      id,
      sourceName,
      channels,
      address: definition.address,
      logic: () => typeof definition.logic === "function" ? definition.logic(context) : definition.logic
    }
  }
  if ("child" in definition) {
    return resolveChild(
      definition,
      path,
      () => typeof definition.input === "function" ? definition.input(context) : definition.input
    )
  }
  const unsupported: never = definition
  throw new Error(`Unsupported captured machine invocation: ${String(unsupported)}`)
}

const noGroups: ReadonlyArray<InvocationGroup> = []

/**
 * Resolves the invocations started by the states a step entered.
 *
 * Groups follow the planner's entry order and contain only paths active in the
 * configuration. Invocations keep their declaration order. A state without
 * invocations has no group.
 *
 * @internal
 */
export const resolve = (
  machine: Machine.Any,
  configuration: Configuration.ActiveConfiguration,
  entryPaths: ReadonlyArray<string>,
  event: Machine.LifecycleEvent<any>,
  capabilities: InvocationCapabilities
): ReadonlyArray<InvocationGroup> => {
  let groups: Array<InvocationGroup> | undefined
  for (const path of Planner.sortEntryPaths(machine, entryPaths)) {
    if (!configuration.active.has(path)) continue
    const definitions = InvocationDefinition.definitions(Configuration.getStateConfigByPath(machine, path)?.invoke)
    if (definitions.length === 0) continue
    let context: InvocationDefinition.Context | undefined
    ;(groups ??= []).push({
      path,
      invocations: definitions.map((definition) =>
        "child" in definition && !("input" in definition)
          ? resolveChild(definition, path, undefined)
          : resolveDefinition(
            definition,
            path,
            context ??= {
              ...capabilities,
              state: configuration.values.get(path),
              containingState: Configuration.getParentValue(machine, configuration, path),
              ancestors: Configuration.getParentValues(machine, configuration, path),
              event
            }
          )
      )
    })
  }
  return groups ?? noGroups
}
