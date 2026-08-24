import type * as MachineDocument from "../MachineDocument.js"
import type * as MachineSimulator from "../MachineSimulator.js"

type State = MachineDocument.State
type Transition = MachineDocument.Transition

interface Model {
  readonly states: ReadonlyMap<string, State>
  readonly order: ReadonlyMap<string, number>
}

const makeModel = (document: MachineDocument.MachineDocument): Model => ({
  states: new Map(document.states.map((state) => [state.path, state])),
  order: new Map(document.states.map((state) => [state.path, state.order]))
})

const ordered = (model: Model, paths: Iterable<string>): ReadonlyArray<string> =>
  [...new Set(paths)].sort((left, right) => (model.order.get(left) ?? 0) - (model.order.get(right) ?? 0))

const enter = (model: Model, path: string, active: Set<string>): void => {
  const state = model.states.get(path)
  if (state === undefined) return
  active.add(path)
  if (state.type === "parallel") {
    state.children.forEach((child) => enter(model, child, active))
  } else if (state.type === "compound" && state.initial !== null) {
    enter(model, state.initial, active)
  }
}

const ancestors = (model: Model, path: string): ReadonlyArray<string> => {
  const result: Array<string> = []
  let current = model.states.get(path)
  while (current !== undefined) {
    result.unshift(current.path)
    current = current.parent === null ? undefined : model.states.get(current.parent)
  }
  return result
}

const leastCommonAncestor = (model: Model, left: string, right: string): string | null => {
  const leftAncestors = ancestors(model, left)
  const rightAncestors = ancestors(model, right)
  let result: string | null = null
  const length = Math.min(leftAncestors.length, rightAncestors.length)
  for (let index = 0; index < length; index++) {
    if (leftAncestors[index] !== rightAncestors[index]) break
    result = leftAncestors[index] ?? null
  }
  return result
}

const isDescendant = (model: Model, path: string, ancestor: string): boolean =>
  path !== ancestor && ancestors(model, path).includes(ancestor)

const candidateEvents = (
  document: MachineDocument.MachineDocument,
  activePaths: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const active = new Set(activePaths)
  return [
    ...new Set(
      document.transitions.flatMap((transition): ReadonlyArray<string> =>
        transition.trigger.type === "event" && active.has(transition.source) ? [transition.trigger.event] : []
      )
    )
  ].sort()
}

const snapshot = (
  document: MachineDocument.MachineDocument,
  model: Model,
  step: number,
  activePaths: Iterable<string>
): MachineSimulator.Snapshot => {
  const active = ordered(model, activePaths)
  return {
    step,
    activePaths: active,
    candidateEvents: candidateEvents(document, active)
  }
}

export const start = (document: MachineDocument.MachineDocument): MachineSimulator.Session => {
  const model = makeModel(document)
  const active = new Set<string>()
  if (document.snapshot === null) {
    const targetAncestors = ancestors(model, document.initial.target)
    targetAncestors.forEach((path) => active.add(path))
    enter(model, document.initial.target, active)
  } else {
    document.snapshot.activePaths.forEach((path) => active.add(path))
  }
  return { document, snapshot: snapshot(document, model, 0, active) }
}

const indeterminate = (
  session: MachineSimulator.Session,
  event: string,
  transitions: ReadonlyArray<Transition>,
  reason: MachineSimulator.Indeterminate["reason"]
): MachineSimulator.Indeterminate => ({
  _tag: "Indeterminate",
  event,
  transitionIds: transitions.map((transition) => transition.id),
  session: session.snapshot,
  reason
})

const notesFor = (
  document: MachineDocument.MachineDocument,
  transition: Transition,
  nextActive: ReadonlyArray<string>
): ReadonlyArray<MachineSimulator.Note> => {
  const notes = new Set<MachineSimulator.Note>(["runtime-effects-skipped"])
  if (transition.reenter) notes.add("reentry-lifecycles-skipped")
  if (transition.branches.some((branch) => branch.updates.length > 0)) notes.add("state-updates-skipped")
  const active = new Set(nextActive)
  if (
    document.transitions.some((candidate) =>
      active.has(candidate.source) &&
      (candidate.trigger.type === "always" || candidate.trigger.type === "choice" || candidate.trigger.type === "done")
    )
  ) {
    notes.add("automatic-transitions-skipped")
  }
  return [...notes]
}

const nextConfiguration = (
  session: MachineSimulator.Session,
  transition: Transition,
  target: string | null
): MachineSimulator.Session | undefined => {
  const document = session.document
  const model = makeModel(document)
  if (target === null) {
    return {
      document,
      snapshot: snapshot(document, model, session.snapshot.step + 1, session.snapshot.activePaths)
    }
  }
  if (!model.states.has(target)) return undefined

  const naturalBoundary = leastCommonAncestor(model, transition.source, target)
  const sourceParent = model.states.get(transition.source)?.parent ?? null
  const boundary = transition.reenter
    ? sourceParent === null || naturalBoundary === null
      ? null
      : ancestors(model, naturalBoundary).length <= ancestors(model, sourceParent).length
      ? naturalBoundary
      : sourceParent
    : naturalBoundary
  const active = new Set(session.snapshot.activePaths)
  for (const path of active) {
    if (boundary === null || isDescendant(model, path, boundary)) active.delete(path)
  }
  ancestors(model, target).forEach((path) => {
    if (boundary === null || path === boundary || isDescendant(model, path, boundary)) active.add(path)
  })
  enter(model, target, active)
  return { document, snapshot: snapshot(document, model, session.snapshot.step + 1, active) }
}

export const send = (session: MachineSimulator.Session, event: string): MachineSimulator.StepResult => {
  const active = new Set(session.snapshot.activePaths)
  const transitions = session.document.transitions.filter((transition) =>
    transition.trigger.type === "event" && transition.trigger.event === event && active.has(transition.source)
  )
  if (transitions.length === 0) {
    return {
      _tag: "Blocked",
      event,
      transitionIds: [],
      session: session.snapshot,
      reason: "event-not-enabled"
    }
  }
  if (transitions.length > 1) return indeterminate(session, event, transitions, "multiple-transitions")
  const transition = transitions[0]!
  if (transition.acceptance === "declinable") {
    return indeterminate(session, event, transitions, "declinable-transition")
  }
  if (transition.branches.length !== 1 || transition.branches[0]?.type === "branch") {
    return indeterminate(session, event, transitions, "conditional-branches")
  }
  const branch = transition.branches[0]!
  if (branch.selection.kind === "history") return indeterminate(session, event, transitions, "history-target")
  if (branch.selection.kind === "choice") return indeterminate(session, event, transitions, "choice-target")
  const next = nextConfiguration(session, transition, branch.target)
  if (next === undefined) return indeterminate(session, event, transitions, "missing-target")
  return {
    _tag: "Applied",
    event,
    transitionIds: [transition.id],
    session: next.snapshot,
    notes: notesFor(session.document, transition, next.snapshot.activePaths)
  }
}
