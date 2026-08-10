/**
 * Bounded breadth-first exploration over concrete planner events.
 *
 * @since 4.0.0
 */

import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Graph from "effect/Graph"
import * as Schema from "effect/Schema"
import * as Machine from "../../../Machine.js"
import type {
  Exploration,
  ExplorationCompleteness,
  ExplorationEdge,
  ExplorationFrontier,
  ExplorationKey,
  ExplorationNode,
  ExplorationPredicate,
  ExplorationStateContext,
  ExploreOptions,
  ReachabilityFailure,
  ResolvedExplorationLimits,
  RunError,
  RunFailure,
  RunServices,
  Scenario,
  Trace
} from "../../../testing/MachineTest.js"
import type { EnsureExecutable } from "../../machine/readiness.js"
import { assertInvariants, type InvariantError } from "./invariant.js"
import { appendTrace, run } from "./trace.js"

type AnyMachine = Machine.Machine.Any

type InputValue<M extends AnyMachine> = Machine.Machine.Input<M>["Type"]

type ReadyMachine<M extends AnyMachine> =
  & M
  & EnsureExecutable<
    Machine.Machine.States<M>,
    Machine.Machine.UnhandledStates<M>,
    Machine.Machine.OutputStates<M>
  >

const defaultLimits: ResolvedExplorationLimits = {
  maxDepth: 20,
  maxStates: 1_000,
  maxTransitions: 10_000
}

const validateLimit = (name: keyof ResolvedExplorationLimits, value: number, minimum: number): void => {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`MachineTest.explore expected ${name} to be a safe integer greater than or equal to ${minimum}`)
  }
}

const resolveLimits = (limits: ExploreOptions<AnyMachine, ExplorationKey>["limits"]): ResolvedExplorationLimits => {
  const resolved = {
    maxDepth: limits?.maxDepth ?? defaultLimits.maxDepth,
    maxStates: limits?.maxStates ?? defaultLimits.maxStates,
    maxTransitions: limits?.maxTransitions ?? defaultLimits.maxTransitions
  }
  validateLimit("maxDepth", resolved.maxDepth, 0)
  validateLimit("maxStates", resolved.maxStates, 1)
  validateLimit("maxTransitions", resolved.maxTransitions, 0)
  return resolved
}

const validateKey = <Key extends ExplorationKey>(key: Key): Key => {
  if (typeof key !== "string" && typeof key !== "number" && typeof key !== "symbol") {
    throw new Error("MachineTest.explore expected stateKey to return a string, number, or symbol")
  }
  return key
}

const stateContext = <M extends AnyMachine>(machine: M, trace: Trace<M>): ExplorationStateContext<M> => ({
  machine,
  snapshot: trace.final,
  configuration: trace.finalConfiguration,
  depth: trace.steps.length,
  trace
})

const scenarioWithEvent = <M extends AnyMachine>(
  trace: Trace<M>,
  event: Machine.Machine.InputEvent<M>
): Scenario<M> =>
  ({
    ...trace.scenario,
    events: [...trace.scenario.events, event]
  }) as Scenario<M>

interface ExplorationEdgeDraft<M extends AnyMachine> {
  readonly source: number
  readonly target: number
  readonly edge: ExplorationEdge<M>
}

export const explore = <M extends AnyMachine, Key extends ExplorationKey>(
  machine: ReadyMachine<M>,
  options: ExploreOptions<M, Key>
): Effect.Effect<
  Exploration<M, Key>,
  RunFailure<RunError<M>, M> | InvariantError<M>,
  RunServices<M>
> => {
  const limits = resolveLimits(options.limits)
  const initialScenario = (machine.input === undefined || machine.input === Schema.Void
    ? { events: [] }
    : { input: (options as { readonly input: InputValue<M> }).input, events: [] }) as unknown as Scenario<M>

  return Effect.gen(function*() {
    const initialTrace = yield* run(machine, initialScenario)
    const invariants = options.invariants ?? []
    if (invariants.length > 0) {
      yield* assertInvariants(machine, initialTrace, invariants)
    }

    const initialContext = stateContext(machine, initialTrace)
    const initialKey = validateKey(options.stateKey(initialContext))
    const nodes: Array<ExplorationNode<M, Key>> = [{ ...initialContext, key: initialKey }]
    const nodeDraftsByKey = new Map<Key, number>([[initialKey, 0]])
    const edges: Array<ExplorationEdgeDraft<M>> = []
    const frontier: Array<ExplorationFrontier<M, Key>> = []
    const reasons = new Set<"depth" | "states" | "transitions">()
    let plannedTransitions = 0
    let cursor = 0
    let halted = false

    while (cursor < nodes.length && !halted) {
      const sourceIndex = cursor
      const source = nodes[cursor++]!
      const candidates = options.events(source)
      if (!Array.isArray(candidates)) {
        throw new Error("MachineTest.explore expected events to return a readonly array")
      }

      if (source.depth >= limits.maxDepth) {
        if (candidates.length > 0) reasons.add("depth")
        for (const event of candidates) {
          frontier.push({
            _tag: "DepthLimit",
            source: source.key,
            trace: source.trace,
            event
          })
        }
        continue
      }

      for (const event of candidates) {
        if (plannedTransitions >= limits.maxTransitions) {
          reasons.add("transitions")
          frontier.push({
            _tag: "TransitionLimit",
            source: source.key,
            trace: source.trace,
            event
          })
          halted = true
          break
        }

        const scenario = scenarioWithEvent(source.trace, event)
        const targetTrace = yield* appendTrace(machine, source.trace, event, scenario)
        plannedTransitions += 1
        if (invariants.length > 0) {
          yield* assertInvariants(machine, targetTrace, invariants)
        }

        const targetContext = stateContext(machine, targetTrace)
        const targetKey = validateKey(options.stateKey(targetContext))
        const existing = nodeDraftsByKey.get(targetKey)
        if (existing !== undefined) {
          edges.push({
            source: sourceIndex,
            target: existing,
            edge: {
              event,
              step: targetTrace.steps[targetTrace.steps.length - 1]!,
              discovered: false
            }
          })
          continue
        }

        if (nodes.length >= limits.maxStates) {
          reasons.add("states")
          frontier.push({
            _tag: "StateLimit",
            source: source.key,
            trace: source.trace,
            event,
            target: targetKey,
            targetTrace
          })
          halted = true
          break
        }

        const targetIndex = nodes.length
        nodeDraftsByKey.set(targetKey, targetIndex)
        nodes.push({ ...targetContext, key: targetKey })
        edges.push({
          source: sourceIndex,
          target: targetIndex,
          edge: {
            event,
            step: targetTrace.steps[targetTrace.steps.length - 1]!,
            discovered: true
          }
        })
      }
    }

    const nodeIndexes: Array<Graph.NodeIndex> = []
    const graph = Graph.directed<ExplorationNode<M, Key>, ExplorationEdge<M>>((mutable) => {
      for (const node of nodes) nodeIndexes.push(Graph.addNode(mutable, node))
      for (const edge of edges) {
        Graph.addEdge(mutable, nodeIndexes[edge.source]!, nodeIndexes[edge.target]!, edge.edge)
      }
    })
    const nodesByKey = new Map<Key, Graph.NodeIndex>()
    nodes.forEach((node, index) => nodesByKey.set(node.key, nodeIndexes[index]!))
    const completeness: ExplorationCompleteness<M, Key> = reasons.size === 0
      ? { _tag: "Complete" }
      : {
        _tag: "Truncated",
        reasons: (["depth", "states", "transitions"] as const).filter((reason) => reasons.has(reason)),
        frontier
      }

    return {
      graph,
      nodes,
      nodesByKey,
      start: nodeIndexes[0]!,
      limits,
      stats: {
        states: nodes.length,
        plannedTransitions,
        retainedEdges: edges.length,
        maxDepth: nodes.reduce((maximum, node) => Math.max(maximum, node.depth), 0)
      },
      completeness
    }
  })
}

export class ReachabilityError<
  M extends AnyMachine = AnyMachine,
  Key extends ExplorationKey = ExplorationKey
> extends Data.TaggedError("MachineTestReachabilityError")<{
  readonly name: string
  readonly expectation: "reachable" | "unreachable"
  readonly reason: ReachabilityFailure
  readonly message: string
  readonly completeness: ExplorationCompleteness<M, Key>
  readonly witness?: ExplorationNode<M, Key>
}> {}

const validateAssertionName = (name: string): void => {
  if (name.trim().length === 0) {
    throw new Error("MachineTest reachability assertions expected name to be a non-empty string")
  }
}

export const findShortest = <M extends AnyMachine, Key extends ExplorationKey>(
  exploration: Exploration<M, Key>,
  predicate: ExplorationPredicate<M, Key>
): ExplorationNode<M, Key> | undefined => exploration.nodes.find(predicate)

export const assertReachable = <M extends AnyMachine, Key extends ExplorationKey>(
  exploration: Exploration<M, Key>,
  name: string,
  predicate: ExplorationPredicate<M, Key>
): Effect.Effect<ExplorationNode<M, Key>, ReachabilityError<M, Key>> => {
  validateAssertionName(name)
  return Effect.suspend(() => {
    const witness = findShortest(exploration, predicate)
    if (witness !== undefined) return Effect.succeed(witness)
    const inconclusive = exploration.completeness._tag === "Truncated"
    return Effect.fail(
      new ReachabilityError({
        name,
        expectation: "reachable",
        reason: inconclusive ? "Inconclusive" : "NotFound",
        message: inconclusive
          ? `Reachability of ${name} is inconclusive because exploration was truncated`
          : `Expected ${name} to be reachable`,
        completeness: exploration.completeness
      })
    )
  })
}

export const assertUnreachable = <M extends AnyMachine, Key extends ExplorationKey>(
  exploration: Exploration<M, Key>,
  name: string,
  predicate: ExplorationPredicate<M, Key>
): Effect.Effect<void, ReachabilityError<M, Key>> => {
  validateAssertionName(name)
  return Effect.suspend(() => {
    const witness = findShortest(exploration, predicate)
    if (witness !== undefined) {
      return Effect.fail(
        new ReachabilityError({
          name,
          expectation: "unreachable",
          reason: "UnexpectedMatch",
          message: `Expected ${name} to be unreachable but found a witness at depth ${witness.depth}`,
          completeness: exploration.completeness,
          witness
        })
      )
    }
    if (exploration.completeness._tag === "Truncated") {
      return Effect.fail(
        new ReachabilityError({
          name,
          expectation: "unreachable",
          reason: "Inconclusive",
          message: `Unreachability of ${name} is inconclusive because exploration was truncated`,
          completeness: exploration.completeness
        })
      )
    }
    return Effect.void
  })
}
