/**
 * Runs resolved invocations as owned processes of the local runtime.
 *
 * @since 0.4.0
 */

import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import type { ChildMachine, ChildOwner, Machine } from "../../Machine.js"
import * as ChildRegistry from "./childRegistry.js"
import * as Configuration from "./configuration.js"
import { ChildAlreadyExistsError } from "./errors.js"
import type * as InvocationEvent from "./invocationEvent.js"
import * as InvocationOutcome from "./invocationOutcome.js"
import * as InvocationResolution from "./invocationResolution.js"
import * as Runtime from "./runtimeProtocol.js"
import { type ChildMachineLogicSlot, ChildMachineLogicTypeId } from "./symbols.js"

type AnyProcessLogic = Runtime.ProcessLogic<any, any, any, any, any, any>

/** Invocations the runtime hosts as an inspected and traced activity. */
type ProgramInvocation =
  | InvocationResolution.EffectInvocation
  | InvocationResolution.TimerInvocation
  | InvocationResolution.StreamInvocation

/** @internal */
export const makeKey = (path: string, id: string): string => `${path.length}:${path}${id}`

/** @internal */
export const makeChildId = (path: string, id: string): string =>
  `${ChildRegistry.invocationChildIdPrefix}${makeKey(path, id)}`

const oneShot = (
  effect: Effect.Effect<unknown, unknown, unknown>
): Runtime.ProcessLogic<void, unknown, unknown, unknown, unknown> => ({
  initial: () => Effect.void,
  run: () => effect
})

const streamLogic = (
  invocation: InvocationResolution.StreamInvocation,
  generation: InvocationEvent.Generation
): Runtime.ProcessLogic<void, unknown, unknown, unknown, void> => {
  const stream = invocation.stream()
  return {
    initial: () => Effect.void,
    run: ({ parent }) => {
      const send = parent?.[Runtime.acknowledgedSend]
      if (send === undefined) {
        return Effect.die(new Error("Stream invocation requires an acknowledged parent machine"))
      }
      return Stream.runForEach(
        stream,
        (element) => {
          const decision = InvocationOutcome.decideElement(invocation, generation, element)
          return decision._tag === "Ignore"
            ? Effect.interrupt
            : send(decision.event).pipe(
              Effect.asVoid,
              Effect.catchCause(() => Effect.interrupt)
            )
        }
      )
    }
  }
}

const makeChildOwner = (scope: Runtime.ProcessScope<any>): ChildOwner<any> => ({
  spawn: <const Child extends ChildMachine.Any>(
    child: Child & ChildMachine.Executable<Child> & ChildMachine.ParentCompatibility<Child, any>,
    ...options: ChildMachine.SpawnArgs<Child>
  ) => scope.spawn<Child>(child, ...options),
  sendTo: (descriptor: ChildMachine.Any, event: unknown) => scope.sendTo(descriptor, event),
  stop: (descriptor: ChildMachine.Any) => scope.stopChild(descriptor)
})

const runSequentialDiscard = <E, R>(
  effects: ReadonlyArray<Effect.Effect<void, E, R>>
): Effect.Effect<void, E, R> =>
  effects.length === 1
    ? effects[0]!
    : Effect.all(effects, { discard: true })

const sendLifecycle = (
  scope: Runtime.ProcessScope<any>,
  event: InvocationEvent.InvocationEvent,
  activitySessionId?: string
): Effect.Effect<void> =>
  (activitySessionId === undefined
    ? scope.self.send(event)
    : scope.self.sendInspected === undefined
    ? scope.self.send(event)
    : scope.self.sendInspected(
      event,
      scope.self.inspectionSubject,
      { _tag: "Activity", activitySessionId }
    )).pipe(Effect.catchTag("StoppedError", () => Effect.void))

const isProgram = (invocation: InvocationResolution.ResolvedInvocation): invocation is ProgramInvocation => {
  switch (invocation._tag) {
    case "Effect":
    case "Timer":
    case "Stream":
      return true
    case "Logic":
    case "Child":
      return false
  }
}

const childSource = (invocation: InvocationResolution.ChildInvocation): (input?: unknown) => AnyProcessLogic =>
  (invocation.child as unknown as ChildMachineLogicSlot)[ChildMachineLogicTypeId]

const traced = (
  scope: Runtime.ProcessScope<any>,
  invocation: ProgramInvocation,
  logic: AnyProcessLogic
): AnyProcessLogic => ({
  ...logic,
  run: (context: Runtime.ProcessContext<any, any>) =>
    Effect.withSpan(
      Effect.suspend(() => logic.run(context)),
      "Machine.invoke",
      {
        attributes: {
          "machine.id": scope.self.id,
          "machine.sessionId": scope.self.sessionId,
          "machine.state.path": invocation.path,
          "machine.invoke.id": invocation.id,
          "machine.invoke.source": invocation.sourceName ?? invocation.id,
          "machine.invoke.kind": invocation._tag,
          "machine.invoke.sessionId": context.self.sessionId
        },
        captureStackTrace: false
      }
    )
})

// Source construction keeps its startup failure boundary. Only the hosted
// program is wrapped; child statecharts retain their execution descriptors.
const programLogic = (
  scope: Runtime.ProcessScope<any>,
  invocation: ProgramInvocation,
  generation: InvocationEvent.Generation
): AnyProcessLogic => {
  switch (invocation._tag) {
    case "Effect":
      return traced(scope, invocation, oneShot(invocation.effect()))
    case "Timer":
      return traced(scope, invocation, oneShot(Effect.flatMap(invocation.duration(), Effect.sleep)))
    case "Stream":
      return traced(scope, invocation, streamLogic(invocation, generation))
  }
}

// Logic addresses and child descriptor ids are caller-chosen; every other id is
// owned by the runtime.
const childId = (invocation: InvocationResolution.ResolvedInvocation): string => {
  switch (invocation._tag) {
    case "Effect":
    case "Timer":
    case "Stream":
      return makeChildId(invocation.path, invocation.id)
    case "Logic":
      return invocation.address
    case "Child":
      return invocation.child.id
  }
}

// A running invocation retains this closure context, so every closure below
// shares it and captures only the scope, the description, and the generation.
const spawn = (
  scope: Runtime.ProcessScope<any>,
  ownedChildren: Runtime.OwnedChildRuntime,
  invocation: InvocationResolution.ResolvedInvocation,
  generation: InvocationEvent.Generation
): Effect.Effect<void, any, any> =>
  ownedChildren.spawn(
    isProgram(invocation)
      ? () => programLogic(scope, invocation, generation)
      : invocation._tag === "Logic"
      ? invocation.logic
      // A zero-input child has no entry-context dependency. Reuse the
      // descriptor's source function so each running parent does not retain a
      // redundant closure.
      : invocation.input === undefined
      ? childSource(invocation)
      : () => childSource(invocation)(invocation.input?.()),
    {
      key: makeKey(invocation.path, invocation.id),
      path: invocation.path,
      id: childId(invocation),
      duplicateId: invocation.id,
      ...(invocation._tag === "Child" ? { descriptor: invocation.child } : undefined),
      ...(isProgram(invocation) ? { activityKind: invocation._tag } : undefined),
      sendParent: (isCurrent, event) => isCurrent() ? scope.self.send(event) : Effect.void,
      // The work starts while the event that entered its state is processed,
      // and its outcome is handled in a later turn, even when the work
      // completes without suspending. The entered state is therefore always
      // observed before the outcome leaves it, and the outcome of a state that
      // was exited in between is discarded.
      onOutcome: (isCurrent, outcome, activitySessionId) =>
        Effect.andThen(
          Effect.yieldNow,
          Effect.suspend(() => {
            if (!isCurrent()) return Effect.void
            const decision = InvocationOutcome.decide(invocation, generation, outcome)
            switch (decision._tag) {
              case "Deliver":
                return sendLifecycle(scope, decision.event, isProgram(invocation) ? activitySessionId : undefined)
              case "Fail":
                return scope.failCause(decision.cause)
              case "Ignore":
                return Effect.void
            }
          })
        ),
      ...(invocation.channels.snapshot
        ? {
          onSnapshot: (isCurrent: () => boolean, snapshot: unknown) => {
            if (!isCurrent()) return Effect.void
            const decision = InvocationOutcome.decideSnapshot(invocation, generation, snapshot)
            return decision._tag === "Ignore" ? Effect.void : sendLifecycle(scope, decision.event)
          }
        }
        : undefined)
    }
  )

// Keep caller-chosen ids out of the namespace reserved for runtime-owned
// invocation ids; runtime-owned ids skip this check.
const start = (
  scope: Runtime.ProcessScope<any>,
  ownedChildren: Runtime.OwnedChildRuntime,
  invocation: InvocationResolution.ResolvedInvocation,
  generation: InvocationEvent.Generation
): Effect.Effect<void, any, any> =>
  !isProgram(invocation) && ChildRegistry.isReservedChildId(childId(invocation))
    ? Effect.fail(new ChildAlreadyExistsError({ id: invocation.id }))
    : Effect.suspend(() => spawn(scope, ownedChildren, invocation, generation))

/**
 * Starts every invocation owned by active entry paths in deterministic entry
 * order. `undefined` keeps the compiled drain free of empty Effect nodes.
 *
 * @internal
 */
export const startAll = (
  machine: Machine.Any,
  scope: Runtime.ProcessScope<any>,
  ownedChildren: Runtime.OwnedChildRuntime,
  configuration: Configuration.ActiveConfiguration,
  paths: ReadonlyArray<string>,
  event: Machine.LifecycleEvent<any>
): Effect.Effect<void, any, any> | undefined => {
  const references = Configuration.getMachineReferences(configuration) ?? scope
  const groups = InvocationResolution.resolve(machine, configuration, paths, event, {
    self: references.self,
    parent: references.parent,
    children: makeChildOwner(scope)
  })
  if (groups.length === 0) return undefined
  const effects: Array<Effect.Effect<void, any, any>> = []
  for (const group of groups) {
    // Every invocation started by this entry shares one generation, which its
    // outcomes carry until the state exits.
    const generation = ownedChildren.beginGeneration(group.path)
    for (const invocation of group.invocations) {
      effects.push(start(scope, ownedChildren, invocation, generation))
    }
  }
  return runSequentialDiscard(effects)
}
