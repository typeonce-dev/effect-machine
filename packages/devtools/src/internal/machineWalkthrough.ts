import * as Result from "effect/Result"
import type * as MachineDocument from "../MachineDocument.js"
import type * as MachineWalkthrough from "../MachineWalkthrough.js"

/** @internal */
export const SessionTypeId = "@typeonce/effect-machine-devtools/MachineWalkthrough/Session" as const

interface HistoryRecord {
  readonly mode: "shallow" | "deep"
  readonly paths: ReadonlyArray<string>
}

interface InternalSnapshot {
  readonly activePaths: ReadonlyArray<string>
  readonly history: ReadonlyMap<string, HistoryRecord>
}

interface InternalFrame {
  readonly public: MachineWalkthrough.Frame
  readonly snapshot: InternalSnapshot
}

interface SessionImpl extends MachineWalkthrough.Session {
  readonly document: MachineDocument.MachineDocument
  readonly cursor: number
  readonly frames: ReadonlyArray<InternalFrame>
}

interface Model {
  readonly states: ReadonlyMap<string, MachineDocument.State>
  readonly order: ReadonlyMap<string, number>
}

interface PublicApi {
  readonly ChoiceNotFound: typeof MachineWalkthrough.ChoiceNotFound
  readonly ChoiceUnavailable: typeof MachineWalkthrough.ChoiceUnavailable
  readonly StepNotFound: typeof MachineWalkthrough.StepNotFound
}

const makeModel = (document: MachineDocument.MachineDocument): Model => ({
  states: new Map(document.states.map((state) => [state.path, state])),
  order: new Map(document.states.map((state) => [state.path, state.order]))
})

const ordered = (model: Model, paths: Iterable<string>): ReadonlyArray<string> =>
  [...new Set(paths)].sort((left, right) => (model.order.get(left) ?? 0) - (model.order.get(right) ?? 0))

const ancestors = (model: Model, path: string): ReadonlyArray<string> => {
  const result: Array<string> = []
  let current = model.states.get(path)
  while (current !== undefined) {
    result.unshift(current.path)
    current = current.parent === null ? undefined : model.states.get(current.parent)
  }
  return result
}

const isDescendant = (model: Model, path: string, ancestor: string): boolean =>
  path !== ancestor && ancestors(model, path).includes(ancestor)

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

const add = (active: Set<string>, entered: Set<string>, path: string): void => {
  if (!active.has(path)) entered.add(path)
  active.add(path)
}

const enter = (
  model: Model,
  path: string,
  active: Set<string>,
  entered: Set<string>,
  history: ReadonlyMap<string, HistoryRecord>
): void => {
  const state = model.states.get(path)
  if (state === undefined) return
  if (state.type === "history") {
    const record = history.get(path)
    if (record === undefined) {
      add(active, entered, path)
      return
    }
    if (record.mode === "deep") {
      record.paths.forEach((recorded) => add(active, entered, recorded))
    } else {
      record.paths.forEach((recorded) => enter(model, recorded, active, entered, history))
    }
    return
  }
  add(active, entered, path)
  if (state.type === "parallel") {
    state.children.forEach((child) => enter(model, child, active, entered, history))
  } else if (state.type === "compound" && state.initial !== null) {
    enter(model, state.initial, active, entered, history)
  }
}

const completeParallelRegions = (
  model: Model,
  active: Set<string>,
  entered: Set<string>,
  history: ReadonlyMap<string, HistoryRecord>
): void => {
  for (const state of model.states.values()) {
    if (state.type !== "parallel" || !active.has(state.path)) continue
    state.children.forEach((child) => {
      if (!active.has(child)) enter(model, child, active, entered, history)
    })
  }
}

const snapshot = (
  model: Model,
  activePaths: Iterable<string>,
  history: ReadonlyMap<string, HistoryRecord>
): InternalSnapshot => ({
  activePaths: ordered(model, activePaths),
  history: new Map(history)
})

const publicSnapshot = (value: InternalSnapshot): MachineWalkthrough.Snapshot => ({
  activePaths: value.activePaths
})

const makeSession = (
  document: MachineDocument.MachineDocument,
  cursor: number,
  frames: ReadonlyArray<InternalFrame>
): MachineWalkthrough.Session =>
  ({
    [SessionTypeId]: SessionTypeId,
    document,
    cursor,
    frames
  }) as SessionImpl

const session = (self: MachineWalkthrough.Session): SessionImpl => self as SessionImpl

const initialSnapshot = (document: MachineDocument.MachineDocument, model: Model): InternalSnapshot => {
  if (document.snapshot !== null) return snapshot(model, document.snapshot.activePaths, new Map())
  const active = new Set<string>()
  const entered = new Set<string>()
  const targetAncestors = ancestors(model, document.initial.target)
  targetAncestors.slice(0, -1).forEach((path) => add(active, entered, path))
  enter(model, document.initial.target, active, entered, new Map())
  return snapshot(model, active, new Map())
}

/** @internal */
export const start = (document: MachineDocument.MachineDocument): MachineWalkthrough.Session => {
  const model = makeModel(document)
  const after = initialSnapshot(document, model)
  const frame: MachineWalkthrough.Frame = {
    step: 0,
    choice: null,
    before: { activePaths: [] },
    after: publicSnapshot(after),
    exitPaths: [],
    entryPaths: after.activePaths,
    changed: after.activePaths.length > 0
  }
  return makeSession(document, 0, [{ public: frame, snapshot: after }])
}

/** @internal */
export const current = (self: MachineWalkthrough.Session): MachineWalkthrough.Frame => {
  const value = session(self)
  return value.frames[value.cursor]!.public
}

/** @internal */
export const timeline = (self: MachineWalkthrough.Session): ReadonlyArray<MachineWalkthrough.Frame> =>
  session(self).frames.map((frame) => frame.public)

/** @internal */
export const cursor = (self: MachineWalkthrough.Session): number => session(self).cursor

const decisions = (
  transition: MachineDocument.Transition,
  branch: MachineDocument.Branch
): ReadonlyArray<MachineWalkthrough.Decision> => {
  const values = new Set<MachineWalkthrough.Decision>()
  if (branch.type === "branch") values.add("conditional-branch")
  if (transition.acceptance === "declinable") values.add("declinable-transition")
  if (transition.trigger.type === "invoke") values.add("invoke-outcome")
  else if (transition.trigger.type !== "event") values.add("automatic-trigger")
  return [...values]
}

const unavailableReason = (
  branch: MachineDocument.Branch,
  history: ReadonlyMap<string, HistoryRecord>
): MachineWalkthrough.UnavailableReason | null => {
  if (branch.selection.kind === "history" && (branch.target === null || !history.has(branch.target))) {
    return "history-unavailable"
  }
  if (
    branch.target === null &&
    branch.selection.kind !== "none" &&
    branch.selection.kind !== "update"
  ) return "runtime-target"
  return null
}

/** @internal */
export const choices = (self: MachineWalkthrough.Session): ReadonlyArray<MachineWalkthrough.Choice> => {
  const value = session(self)
  const frame = value.frames[value.cursor]!
  const active = new Set(frame.snapshot.activePaths)
  const eventInputs = new Map(value.document.inputs.events.map(({ event, schema }) => [event, schema]))
  return value.document.transitions.flatMap((transition): ReadonlyArray<MachineWalkthrough.Choice> => {
    if (!active.has(transition.source)) return []
    return transition.branches.map((branch, branchIndex) => ({
      id: branch.id,
      transitionId: transition.id,
      branchId: branch.id,
      branchIndex,
      branchKey: branch.type === "branch" ? branch.key : null,
      title: branch.type === "branch" ? branch.title : null,
      source: transition.source,
      trigger: transition.trigger,
      target: branch.target,
      selection: branch.selection,
      updates: branch.updates,
      decisions: decisions(transition, branch),
      unavailableReason: unavailableReason(branch, frame.snapshot.history),
      input: transition.trigger.type === "event" ? eventInputs.get(transition.trigger.event) ?? null : null
    }))
  })
}

const recordHistory = (
  document: MachineDocument.MachineDocument,
  model: Model,
  before: ReadonlySet<string>,
  exited: ReadonlySet<string>,
  history: Map<string, HistoryRecord>
): void => {
  for (const state of document.states) {
    if (state.type !== "history" || state.parent === null || !exited.has(state.parent)) continue
    const paths = state.history === "deep"
      ? [...before].filter((path) => {
        const node = model.states.get(path)
        return isDescendant(model, path, state.parent!) && node?.type !== "history" && node?.type !== "choice"
      })
      : [...before].filter((path) => model.states.get(path)?.parent === state.parent)
    if (paths.length > 0) {
      history.set(state.path, {
        mode: state.history === "deep" ? "deep" : "shallow",
        paths: ordered(model, paths)
      })
    }
  }
}

const advance = (
  value: SessionImpl,
  choice: MachineWalkthrough.Choice
): {
  readonly snapshot: InternalSnapshot
  readonly exited: ReadonlyArray<string>
  readonly entered: ReadonlyArray<string>
} => {
  const frame = value.frames[value.cursor]!
  const model = makeModel(value.document)
  if (choice.target === null) {
    return { snapshot: frame.snapshot, exited: [], entered: [] }
  }
  const transition = value.document.transitions.find(({ id }) => id === choice.transitionId)!
  const naturalBoundary = leastCommonAncestor(model, transition.source, choice.target)
  const sourceParent = model.states.get(transition.source)?.parent ?? null
  const boundary = transition.reenter
    ? sourceParent === null || naturalBoundary === null
      ? null
      : ancestors(model, naturalBoundary).length <= ancestors(model, sourceParent).length
      ? naturalBoundary
      : sourceParent
    : naturalBoundary
  const before = new Set(frame.snapshot.activePaths)
  const active = new Set(frame.snapshot.activePaths)
  const exited = new Set(
    frame.snapshot.activePaths.filter((path) => boundary === null || isDescendant(model, path, boundary))
  )
  const history = new Map(frame.snapshot.history)
  recordHistory(value.document, model, before, exited, history)
  exited.forEach((path) => active.delete(path))

  const entered = new Set<string>()
  const targetAncestors = ancestors(model, choice.target)
  targetAncestors.slice(0, -1).forEach((path) => {
    if (boundary === null || path === boundary || isDescendant(model, path, boundary)) add(active, entered, path)
  })
  enter(model, choice.target, active, entered, history)
  completeParallelRegions(model, active, entered, history)
  return {
    snapshot: snapshot(model, active, history),
    exited: ordered(model, exited),
    entered: ordered(model, entered)
  }
}

/** @internal */
export const take = (api: PublicApi) =>
(
  self: MachineWalkthrough.Session,
  choiceId: string
): Result.Result<
  MachineWalkthrough.Session,
  MachineWalkthrough.ChoiceNotFound | MachineWalkthrough.ChoiceUnavailable
> => {
  const value = session(self)
  const choice = choices(self).find(({ id }) => id === choiceId)
  if (choice === undefined) return Result.fail(new api.ChoiceNotFound({ choiceId }))
  if (choice.unavailableReason !== null) {
    return Result.fail(new api.ChoiceUnavailable({ choiceId, reason: choice.unavailableReason }))
  }
  const beforeFrame = value.frames[value.cursor]!
  const next = advance(value, choice)
  const before = publicSnapshot(beforeFrame.snapshot)
  const after = publicSnapshot(next.snapshot)
  const frame: MachineWalkthrough.Frame = {
    step: value.cursor + 1,
    choice,
    before,
    after,
    exitPaths: next.exited,
    entryPaths: next.entered,
    changed: next.exited.length > 0 || next.entered.length > 0
  }
  const frames = [...value.frames.slice(0, value.cursor + 1), { public: frame, snapshot: next.snapshot }]
  return Result.succeed(makeSession(value.document, frames.length - 1, frames))
}

/** @internal */
export const seek = (api: PublicApi) =>
(
  self: MachineWalkthrough.Session,
  step: number
): Result.Result<MachineWalkthrough.Session, MachineWalkthrough.StepNotFound> => {
  const value = session(self)
  if (!Number.isInteger(step) || step < 0 || step >= value.frames.length) {
    return Result.fail(new api.StepNotFound({ step }))
  }
  return Result.succeed(makeSession(value.document, step, value.frames))
}
