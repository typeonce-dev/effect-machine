/**
 * Exact transition-definition and branch coverage collected from retained
 * planner microsteps.
 *
 * @since 0.14.0
 */

import * as Machine from "../../../Machine.js"
import type {
  CoverageSummary,
  Microstep,
  TransitionBranchCoverageItem,
  TransitionCoverage,
  TransitionDefinitionCoverageItem
} from "../../../testing/MachineTest.js"

type AnyMachine = Machine.Machine.Any

type StateNodePath<M extends AnyMachine> = Machine.Machine.StateNodeIdentifier<Machine.Machine.States<M>>

type EventTag<M extends AnyMachine> = Machine.Machine.TagOf<Machine.Machine.Events<M>[number]>

type MachineTransitionCoverage<M extends AnyMachine> = TransitionCoverage<
  StateNodePath<M>,
  EventTag<M>,
  StateNodePath<M>
>

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

export const sameTransitionTrigger = (
  left: Machine.Machine.TransitionTrigger,
  right: Machine.Machine.TransitionTrigger
): boolean => {
  if (left.type !== right.type) return false
  if (left.type === "event") return right.type === "event" && left.event === right.event
  if (left.type === "invoke") {
    return right.type === "invoke" && left.id === right.id && left.outcome === right.outcome
  }
  return true
}

export interface TransitionCoverageCollector<M extends AnyMachine> {
  readonly observeMicrostep: (microstep: Microstep<M, unknown>) => void
  readonly summary: () => MachineTransitionCoverage<M>
}

export const makeTransitionCoverageCollector = <M extends AnyMachine>(
  machine: M
): TransitionCoverageCollector<M> => {
  const definitions = Machine.transitionDefinitions(machine).map(
    (definition, index): TransitionDefinitionCoverageItem<StateNodePath<M>, EventTag<M>, StateNodePath<M>> => ({
      id: `transition:${index}`,
      index,
      source: definition.source,
      trigger: definition.trigger,
      reenter: definition.reenter,
      branches: definition.branches
    })
  )
  const definitionHits = new Set<number>()
  const branchOffsets: Array<number> = []
  const branches: Array<TransitionBranchCoverageItem<StateNodePath<M>, EventTag<M>, StateNodePath<M>>> = []
  for (let definitionIndex = 0; definitionIndex < definitions.length; definitionIndex++) {
    branchOffsets.push(branches.length)
    const definition = definitions[definitionIndex]!
    definition.branches.forEach((branch, branchIndex) => {
      branches.push({
        id: `transition:${definitionIndex}:branch:${branchIndex}`,
        definitionIndex,
        branchIndex,
        source: definition.source,
        trigger: definition.trigger,
        reenter: definition.reenter,
        branch
      })
    })
  }
  const branchHits = new Set<number>()

  return {
    observeMicrostep(microstep) {
      for (const retained of microstep.transitions) {
        const definitionIndex = definitions.findIndex((definition) =>
          definition.source === retained.source &&
          definition.reenter === retained.reenter &&
          sameTransitionTrigger(definition.trigger, retained.trigger)
        )
        if (definitionIndex === -1) continue
        definitionHits.add(definitionIndex)
        const definition = definitions[definitionIndex]!
        if (
          Number.isSafeInteger(retained.branchIndex) && retained.branchIndex >= 0 &&
          retained.branchIndex < definition.branches.length
        ) {
          branchHits.add(branchOffsets[definitionIndex]! + retained.branchIndex)
        }
      }
    },
    summary: () => ({
      definitions: coverageSummary(definitions, definitionHits),
      branches: coverageSummary(branches, branchHits)
    })
  }
}
