import { Effect, Exit, Fiber, Option, Scope, Stream } from "effect"
import { Machine } from "../../../../src/index.js"
import type { Answer, Capabilities, Host, Outcome } from "../host.js"
import { decode, encode, fiberScheduling, renderFailure } from "../host.js"

/** A reference whose types do not matter to the suite. */
export type AnyRef = Machine.MachineRef<any, any, any, any, any>

/** What every host that runs machines in memory declares. */
export const capabilities: Capabilities = {
  invocations: ["Effect", "Timer", "Stream", "Logic", "Child"],
  ownedChildren: true,
  commands: true,
  restart: true,
  stop: true,
  emissions: true,
  rejection: true,
  initialState: "AtStart"
}

export const outcomeOf = (snapshot: Machine.RuntimeSnapshot<unknown, unknown, unknown>): Outcome => {
  switch (snapshot.status) {
    case "active":
      return { _tag: "Running" }
    case "done":
      return snapshot.output === undefined ? { _tag: "Final" } : { _tag: "Final", output: snapshot.output }
    case "failed":
      return { _tag: "Failed", failure: renderFailure(snapshot.cause) }
    case "stopped":
      return { _tag: "Stopped" }
  }
}

/**
 * `send` of a local machine rejects an event that its schema refuses, and
 * fails for a machine that has ended. A machine atom whose start failed
 * fails its writes with that failure, which can refuse a state instead.
 */
export const answerOf = (
  exit: Exit.Exit<unknown, Machine.StoppedError | Machine.MachineSchemaDecodeError>
): Answer =>
  Exit.isSuccess(exit)
    ? "Accepted"
    : Exit.findErrorOption(exit).pipe(
        Option.exists((error) => error._tag === "MachineSchemaDecodeError" && error.boundary === "event")
      )
    ? "Rejected"
    : "Ended"

/**
 * A host over the references of `LocalMachine`. It restarts from the encoded
 * snapshot of its machine, which is what an application can store.
 */
export const makeLocalHost = (options: {
  readonly name: string
  readonly start: (
    machine: Machine.Machine.Any,
    ...input: ReadonlyArray<unknown>
  ) => Effect.Effect<AnyRef, unknown, Scope.Scope>
  readonly resume: (
    machine: Machine.Machine.Any,
    snapshot: Machine.Machine.Snapshot<any>
  ) => Effect.Effect<AnyRef, unknown, Scope.Scope>
}): Host => ({
  name: options.name,
  capabilities,
  start: Effect.fnUntraced(function*({ activity, input, machine }) {
    const outer = yield* Effect.scope
    const states: Array<Machine.Machine.EncodedSnapshot> = []
    const emitted: Array<unknown> = []

    const open = Effect.fnUntraced(function*(starting: Effect.Effect<AnyRef, unknown, Scope.Scope>) {
      const scope = yield* Scope.fork(outer)
      const exit = yield* Effect.exit(Scope.provide(starting, scope))
      if (Exit.isFailure(exit)) return { _tag: "Failed" as const, failure: renderFailure(exit.cause) }
      const ref = exit.value
      // An observer ends before its machine does, so a stop is seen by the
      // outcome alone, like the stop of a host that goes down.
      const observers = yield* Effect.forEach([
        Stream.runForEach(ref.changes, ({ state, status }) =>
          Effect.sync(() => {
            if (status !== "stopped") states.push(encode(machine, state))
          })),
        Stream.runForEach(ref.emissions, (event) =>
          Effect.sync(() => {
            emitted.push(event)
          }))
      ], (observer) => Effect.forkIn(observer, outer, { startImmediately: true }))
      return {
        _tag: "Opened" as const,
        ref,
        close: Effect.andThen(Fiber.interruptAll(observers), Scope.close(scope, Exit.void))
      }
    })

    let opened = yield* open(options.start(machine, ...input))
    const current = () =>
      opened._tag === "Failed" ? undefined : encode(machine, Effect.runSync(opened.ref.snapshot).state)
    const scheduling = fiberScheduling(activity)
    return {
      ...scheduling,
      states,
      emitted,
      current,
      send: (event) =>
        Effect.suspend(() =>
          opened._tag === "Failed" ? Effect.succeed("Ended" as const) : Effect.map(
            Effect.exit(opened.ref.send(event)),
            answerOf
          )
        ),
      outcome: Effect.suspend(() =>
        opened._tag === "Failed"
          ? Effect.succeed<Outcome>(opened)
          : Effect.map(opened.ref.snapshot, outcomeOf)
      ),
      stop: Effect.suspend(() => opened._tag === "Failed" ? Effect.void : opened.ref.stop),
      restart: Effect.fnUntraced(function*(downtimeMillis) {
        if (opened._tag === "Failed") return
        const stored = current()!
        yield* opened.close
        yield* scheduling.advance(downtimeMillis)
        opened = yield* open(options.resume(machine, decode(machine, stored)))
      })
    }
  })
})
