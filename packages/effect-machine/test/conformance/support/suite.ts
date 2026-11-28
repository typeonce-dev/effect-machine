/** Runs scenarios on hosts, and compares what they did. */
import { assert } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Queue, type Scope } from "effect"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { Machine } from "../../../src/index.js"
import type { Difference } from "./difference.js"
import { Fixture, wasStopped } from "./fixture.js"
import type { Answer, Host, Instance, InvocationKind, Outcome } from "./host.js"
import type { Action, Expectation, Happening, Scenario, State } from "./scenario.js"

/** An expectation with nothing left out. */
interface Observation {
  readonly step: string
  readonly answers: ReadonlyArray<Answer | "Pending">
  readonly happens: ReadonlyArray<Happening>
  readonly stopped: ReadonlyArray<string>
  readonly log: ReadonlyArray<string>
  readonly emits: ReadonlyArray<unknown>
  readonly outcome: Outcome
}

type Trace = ReadonlyArray<Observation>

// -----------------------------------------------------------------------------
// cells
// -----------------------------------------------------------------------------

/** What one host does with one scenario. */
export type Cell =
  | { readonly _tag: "Runs" }
  /** The host declares that it lacks these capabilities. */
  | { readonly _tag: "Skipped"; readonly missing: ReadonlyArray<string> }
  | { readonly _tag: "Differs"; readonly difference: Difference }

const kindOf = {
  effect: "Effect",
  timer: "Timer",
  stream: "Stream",
  logic: "Logic",
  machine: "Child"
} as const satisfies Record<string, InvocationKind>

/** Capabilities a scenario needs, read from its machine and its script. */
const missingFrom = ({ capabilities }: Host, scenario: Scenario): ReadonlyArray<string> => {
  const kinds = Machine.invocationDefinitions(scenario.machine(new Fixture())).map(({ type }) => kindOf[type])
  const actions = scenario.steps.flatMap(({ actions }) => actions)
  const emits = [scenario.start, ...scenario.steps].some(({ emits }) => emits !== undefined)
  return [
    ...Array.from(new Set(kinds)).filter((kind) => !capabilities.invocations.includes(kind)),
    ...scenario.needs?.includes("OwnedChildren") === true && !capabilities.ownedChildren ? ["OwnedChildren"] : [],
    ...scenario.needs?.includes("Commands") === true && !capabilities.commands ? ["Commands"] : [],
    ...actions.some(({ _tag }) => _tag === "Restart") && !capabilities.restart ? ["Restart"] : [],
    ...actions.some(({ _tag }) => _tag === "Stop") && !capabilities.stop ? ["Stop"] : [],
    ...emits && !capabilities.emissions ? ["Emissions"] : []
  ]
}

export const cellOf = (host: Host, scenario: Scenario, differences: ReadonlyArray<Difference>): Cell => {
  const missing = missingFrom(host, scenario)
  if (missing.length > 0) return { _tag: "Skipped", missing }
  const difference = differences.find((difference) =>
    difference.scenario === scenario.name && difference.hosts.includes(host.name)
  )
  return difference === undefined ? { _tag: "Runs" } : { _tag: "Differs", difference }
}

const renderCell = (cell: Cell): string => {
  switch (cell._tag) {
    case "Runs":
      return "runs"
    case "Skipped":
      return `skipped: ${cell.missing.join(", ")}`
    case "Differs":
      return cell.difference.kind === "Open" ? "OPEN" : "differs"
  }
}

/** The scenarios by the hosts, as a table. */
export const renderMatrix = (
  hosts: ReadonlyArray<Host>,
  scenarios: ReadonlyArray<Scenario>,
  differences: ReadonlyArray<Difference>
): string => {
  const rows = [
    ["scenario", ...hosts.map(({ name }) => name)],
    ...scenarios.map((scenario) => [
      scenario.name,
      ...hosts.map((host) => renderCell(cellOf(host, scenario, differences)))
    ])
  ]
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)))
  return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column]!)).join(" | ").trimEnd()).join("\n")
}

// -----------------------------------------------------------------------------
// expectations
// -----------------------------------------------------------------------------

const isState = (happening: Happening): happening is State => typeof happening !== "string"

const complete = (step: string, sends: number, expected: Expectation, before: Outcome): Observation => ({
  step,
  answers: expected.answers ?? Array.from({ length: sends }, () => "Accepted" as const),
  happens: expected.happens ?? [],
  stopped: [...expected.stopped ?? []].sort(),
  log: expected.log ?? [],
  emits: expected.emits ?? [],
  outcome: expected.outcome ?? before
})

/** Every step of a scenario by name, where `start` is the first one. */
const stepsOf = (scenario: Scenario) => [{ name: "start", actions: [], ...scenario.start }, ...scenario.steps]

const expectedTrace = (host: Host, scenario: Scenario, difference: Difference | undefined): Trace => {
  let outcome: Outcome = { _tag: "Running" }
  return stepsOf(scenario).map(({ actions, name, ...expected }, index) => {
    const changed: Expectation = { ...expected, ...difference?.steps[name] }
    const observation = complete(
      name,
      actions.filter(({ _tag }) => _tag === "Send").length,
      index === 0 && host.capabilities.initialState === "WithFirstEvent"
        // Nothing is published, and the suite takes the initial state as given.
        ? { ...changed, happens: changed.happens?.filter((happening) => !isState(happening)) ?? [] }
        : changed,
      outcome
    )
    outcome = observation.outcome
    return observation
  })
}

// -----------------------------------------------------------------------------
// runs
// -----------------------------------------------------------------------------

const normalize = ({ active }: Machine.Machine.EncodedSnapshot): State =>
  Object.fromEntries(
    active.flatMap(({ path, value }) => {
      const { _tag, ...fields } = (value ?? {}) as { readonly _tag?: string }
      const implied = Object.keys(fields).length === 0 &&
        active.some((other) => other.path !== path && (path === "" || other.path.startsWith(`${path}.`)))
      return implied ? [] : [[path, fields]]
    })
  )

const performEnd = (
  fixture: Fixture,
  { exit, run, source }: Extract<Action, { readonly _tag: "End" }>
): Effect.Effect<void> => {
  const found = fixture.find(source, run)
  if (found.exit === undefined) found.ended = true
  return Effect.andThen(
    Deferred.done(found.result, exit),
    Exit.isSuccess(exit) ? Queue.end(found.elements) : Queue.failCause(found.elements, exit.cause)
  )
}

const runScenario = Effect.fnUntraced(function*(
  host: Host,
  scenario: Scenario
): Effect.fn.Return<Trace, never, Scope.Scope> {
  const fixture = new Fixture()
  /** The starts of work, with the state that held, if one did. */
  const starts: Array<{ readonly label: string; readonly held: State | "None" | "Unknown" }> = []
  let instance: Instance | undefined
  fixture.onStart = ({ label }) => {
    // Nothing can be asked of an instance that is being started.
    const current = instance?.current()
    const held = instance === undefined ? "Unknown" : current === undefined ? "None" : normalize(current)
    starts.push({ label: `start ${label}`, held })
  }

  const sent: Array<Fiber.Fiber<Answer>> = []
  const pending = () => sent.some((fiber) => fiber.pollUnsafe() === undefined)
  const progress = () =>
    [
      instance?.states.length,
      instance?.emitted.length,
      fixture.runs.length,
      fixture.runs.filter(({ exit }) => exit !== undefined).length,
      fixture.log.length,
      pending()
    ].join()
  /** Lets everything that does not wait for time happen, as the host does it. */
  const settle = Effect.suspend(() => instance!.settle)

  const seen = { states: 0, starts: 0, log: 0, emitted: 0, sent: 0 }
  const stoppedBefore = new Set<unknown>()
  const [initial] = (scenario.start.happens ?? []).filter(isState)
  let last: State | undefined = host.capabilities.initialState === "WithFirstEvent" ? initial : undefined

  const observe = Effect.fnUntraced(function*(step: string): Effect.fn.Return<Observation> {
    yield* settle
    const { emitted, outcome, states } = instance!
    const happens: Array<Happening> = []
    const newStarts = starts.slice(seen.starts)
    // Work that started in the state that already held.
    while (newStarts.length > 0 && isDeepStrictEqual(newStarts[0]!.held, last)) {
      happens.push(newStarts.shift()!.label)
    }
    for (const encoded of states.slice(seen.states)) {
      const state = normalize(encoded)
      if (!isDeepStrictEqual(state, last)) happens.push(state)
      last = state
      while (
        newStarts.length > 0 && (newStarts[0]!.held === "Unknown" || isDeepStrictEqual(newStarts[0]!.held, state))
      ) {
        happens.push(newStarts.shift()!.label)
      }
    }
    // Work that started in no state the host ever published or stored.
    happens.push(...newStarts.map(({ label }) => `${label} too early`))
    const stopped = fixture.runs.filter((run) => wasStopped(run) && !stoppedBefore.has(run))
    for (const run of stopped) stoppedBefore.add(run)
    const observation: Observation = {
      step,
      answers: sent.slice(seen.sent).map((fiber) => {
        const exit = fiber.pollUnsafe()
        return exit === undefined ? "Pending" : Exit.isSuccess(exit) ? exit.value : throwCause(exit.cause)
      }),
      happens,
      stopped: stopped.map(({ label }) => label).sort(),
      log: fixture.log.slice(seen.log),
      emits: emitted.slice(seen.emitted),
      outcome: yield* outcome
    }
    seen.states = states.length
    seen.starts = starts.length
    seen.log = fixture.log.length
    seen.emitted = emitted.length
    seen.sent = sent.length
    return observation
  })

  const perform = (action: Action): Effect.Effect<void, never, Scope.Scope> => {
    switch (action._tag) {
      case "Send":
        return Effect.map(
          Effect.forkScoped(instance!.send(action.event), { startImmediately: true }),
          (fiber) => void sent.push(fiber)
        )
      case "End":
        return performEnd(fixture, action)
      case "Element":
        return Effect.asVoid(Queue.offer(fixture.find(action.source, action.run).elements, action.value))
      case "Advance":
        return instance!.advance(action.duration)
      case "Restart":
        return instance!.restart(action.downtimeMillis)
      case "Stop":
        return instance!.stop
    }
  }

  instance = yield* host.start({
    machine: scenario.machine(fixture),
    input: "input" in scenario ? [scenario.input] : [],
    activity: { progress, pending }
  })
  const trace: Array<Observation> = [yield* observe("start")]
  for (const { actions, name, settled } of scenario.steps) {
    for (const [index, action] of actions.entries()) {
      if (index > 0 && settled !== false) yield* settle
      yield* perform(action)
    }
    trace.push(yield* observe(name))
  }
  return trace
})

const throwCause = (cause: Cause.Cause<unknown>): never => {
  throw Cause.squash(cause)
}

/** Runs one scenario on one host, and checks the cell it belongs to. */
export const check = (
  host: Host,
  scenario: Scenario,
  cell: Exclude<Cell, { readonly _tag: "Skipped" }>
): Effect.Effect<void> =>
  Effect.gen(function*() {
    const trace = yield* runScenario(host, scenario)
    if (!host.capabilities.rejection) {
      assert.isFalse(
        trace.some(({ answers }) => answers.includes("Rejected")),
        `${host.name} rejected an event, which it declares it cannot`
      )
    }
    const reference = expectedTrace(host, scenario, undefined)
    if (cell._tag === "Runs") {
      assert.deepStrictEqual(trace, reference)
      return
    }
    assert.notDeepEqual(
      trace,
      reference,
      `${host.name} no longer differs in "${scenario.name}", so its entry in differences.ts must go`
    )
    assert.deepStrictEqual(trace, expectedTrace(host, scenario, cell.difference))
  }).pipe(Effect.scoped)

// -----------------------------------------------------------------------------
// registry
// -----------------------------------------------------------------------------

const root = resolve(import.meta.dirname, "../../..")

/** The documentation of a module, as prose without comment markers. */
const proseOf = (file: string): string =>
  readFileSync(resolve(root, file), "utf8").replaceAll(/\n\s*\*/g, " ").replaceAll(/\s+/g, " ")

/** Checks that an entry names things that exist, and says where users read it. */
export const checkEntry = (
  difference: Difference,
  hosts: ReadonlyArray<Host>,
  scenarios: ReadonlyArray<Scenario>,
  reference: Host
): void => {
  const scenario = scenarios.find(({ name }) => name === difference.scenario)
  assert(scenario !== undefined, `No scenario is named "${difference.scenario}"`)
  const names = stepsOf(scenario).map(({ name }) => name)
  for (const step of Object.keys(difference.steps)) {
    assert.strictEqual(names.filter((name) => name === step).length, 1, `One step must be named "${step}"`)
  }
  assert.isAbove(difference.hosts.length, 0)
  for (const name of difference.hosts) {
    const host = hosts.find((host) => host.name === name)
    assert(host !== undefined, `No host is named "${name}"`)
    assert.isFalse(host === reference && difference.kind === "Deliberate", "The reference does not differ on purpose")
    assert.notStrictEqual(cellOf(host, scenario, [difference])._tag, "Skipped", `${name} does not run this scenario`)
  }
  if (difference.kind === "Deliberate") {
    const { file, text } = difference.documentedIn
    assert.include(proseOf(file), text, `${file} no longer says this`)
  }
}
