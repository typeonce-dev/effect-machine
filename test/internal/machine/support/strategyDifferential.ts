import { assert } from "@effect/vitest"
import { Effect } from "effect"
import { Machine } from "../../../../src/index.js"
import * as Configuration from "../../../../src/internal/machine/configuration.js"
import * as ExecutionPlan from "../../../../src/internal/machine/executionPlan.js"
import * as Process from "../../../../src/internal/machine/process.js"

const eventTag = (event: unknown): PropertyKey | undefined =>
  typeof event === "object" && event !== null && "_tag" in event
    ? (event as { readonly _tag: PropertyKey })._tag
    : undefined

const commandTags = (commands: ReadonlyArray<{ readonly _tag: string }>): ReadonlyArray<string> =>
  commands.map((command) => command._tag)

const encodeState = (
  machine: Machine.Machine.Any,
  state: unknown
): Effect.Effect<unknown, unknown, unknown> => Machine.encodeSnapshot(machine as any, state as any)

const canonicalMacrostep = Effect.fn(function*(
  machine: Machine.Machine.Any,
  executionPlan: ExecutionPlan.CompiledExecutionPlan,
  planned: ReturnType<ExecutionPlan.CompiledExecutionPlan["plan"]>
) {
  return {
    next: yield* encodeState(machine, executionPlan.snapshot(planned.next)),
    commands: commandTags(planned.commands),
    emittedEvents: planned.emittedEvents,
    microsteps: yield* Effect.forEach(
      planned.microsteps,
      (step) =>
        Effect.map(encodeState(machine, executionPlan.snapshot(step.next)), (next) => ({
          next,
          event: eventTag(step.event),
          commands: commandTags(step.commands),
          raisedEvents: step.raisedEvents.map(eventTag),
          emittedEvents: step.emittedEvents,
          exitPaths: step.exitPaths,
          entryPaths: step.entryPaths,
          changed: step.changed
        }))
    ),
    done: planned.done,
    output: planned.output
  }
})

const verifyPlannerStrategiesEffect = Effect.fn(function*(options: {
  readonly machine: Machine.Machine.Any
  readonly events: ReadonlyArray<{ readonly _tag: PropertyKey }>
  readonly expected?: "indexed-flat" | "indexed-hierarchical" | "generic"
  readonly initialArgs?: ReadonlyArray<unknown>
  readonly label: string
}) {
  const initialArgs = options.initialArgs ?? []
  const initial = yield* (Machine.planInitial as any)(options.machine, ...initialArgs) as Effect.Effect<
    any,
    unknown,
    never
  >
  const generic = ExecutionPlan.selectExecutionPlanForTesting(options.machine, "generic")
  const selected = ExecutionPlan.selectExecutionPlanForTesting(options.machine, "auto")
  if (options.expected !== undefined) {
    assert.strictEqual(selected.strategy, options.expected, `${options.label} selected strategy`)
  }

  if (selected.plan.initial !== undefined) {
    const compiledInitial = selected.plan.initial(initialArgs)
    assert.deepStrictEqual(
      yield* encodeState(options.machine, compiledInitial.state),
      yield* encodeState(options.machine, initial.state),
      `${options.label} compiled initial state`
    )
    assert.deepStrictEqual(compiledInitial.initialEntryPaths, initial.initialEntryPaths)
    assert.strictEqual(compiledInitial.done, initial.done)
    assert.deepStrictEqual(compiledInitial.output, initial.output)
  }

  const active = Configuration.normalizeConfigurationSync(options.machine, initial.state)
  let genericState = generic.plan.fromConfiguration(active)
  let selectedState = selected.plan.fromConfiguration(active)
  for (let index = 0; index < options.events.length; index++) {
    const event = options.events[index]!
    const retainedSelectedSnapshot = selected.plan.snapshot(selectedState)
    const retainedSelectedEncoding = yield* encodeState(options.machine, retainedSelectedSnapshot)
    const genericPlan = generic.plan.plan(genericState, event)
    const selectedPlan = selected.plan.plan(selectedState, event)
    assert.deepStrictEqual(
      yield* canonicalMacrostep(options.machine, selected.plan, selectedPlan),
      yield* canonicalMacrostep(options.machine, generic.plan, genericPlan),
      `${options.label} event ${index}:${String(event._tag)}`
    )
    assert.deepStrictEqual(
      yield* encodeState(options.machine, retainedSelectedSnapshot),
      retainedSelectedEncoding,
      `${options.label} retained snapshot ${index}:${String(event._tag)}`
    )
    genericState = genericPlan.next
    selectedState = selectedPlan.next
    if (genericPlan.done) break
  }
  return selected.strategy
})

export const verifyPlannerStrategies: (options: {
  readonly machine: Machine.Machine.Any
  readonly events: ReadonlyArray<{ readonly _tag: PropertyKey }>
  readonly expected?: "indexed-flat" | "indexed-hierarchical" | "generic"
  readonly initialArgs?: ReadonlyArray<unknown>
  readonly label: string
}) => Effect.Effect<"indexed-flat" | "indexed-hierarchical" | "generic", unknown> = verifyPlannerStrategiesEffect as any

export const openWithRuntimeStrategy = (
  machine: Machine.Machine.Any,
  strategy: "generic" | "compiled"
): Effect.Effect<Machine.MachineRef<any, any, any, any>, unknown> =>
  Process.startWithRuntimeStrategyForTesting(machine, strategy) as any

export const prepareWithRuntimeStrategy = (
  machine: Machine.Machine.Any,
  strategy: "generic" | "compiled"
): Effect.Effect<
  {
    readonly emissions: import("effect/Stream").Stream<unknown>
    readonly inspection: import("effect/Stream").Stream<Machine.Inspection.Event>
    readonly start: Effect.Effect<Machine.MachineRef<any, any, any, any>, unknown>
  },
  unknown
> => Process.prepareWithRuntimeStrategyForTesting(machine, strategy) as any

export const resumeWithRuntimeStrategy = (
  machine: Machine.Machine.Any,
  snapshot: Machine.Machine.Snapshot<any>,
  strategy: "generic" | "compiled"
): Effect.Effect<Machine.MachineRef<any, any, any, any>, unknown> =>
  Process.resumeWithRuntimeStrategyForTesting(machine, snapshot, strategy) as any
