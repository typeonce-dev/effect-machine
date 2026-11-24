/** Hosts of the conformance suite that need internals of the library. */
import { Effect, Exit, Fiber, Semaphore } from "effect"
import type { Machine } from "../../../../src/index.js"
import * as InvocationOutcome from "../../../../src/internal/machine/invocationOutcome.js"
import type { Host, Outcome } from "../../../conformance/support/host.js"
import { encode, renderFailure, unsupported } from "../../../conformance/support/host.js"
import { makeLocalHost } from "../../../conformance/support/hosts/local.js"
import { decide, PlannedHost, type Started } from "./plannedHost.js"
import { openWithRuntimeStrategy, resumeWithRuntimeStrategy } from "./strategyDifferential.js"

const localHost = (strategy: "generic" | "compiled"): Host =>
  makeLocalHost({
    name: `LocalMachine (${strategy})`,
    start: (machine, ...input) => openWithRuntimeStrategy(machine, strategy, ...input),
    resume: (machine, snapshot) => resumeWithRuntimeStrategy(machine, snapshot, strategy)
  })

/** The reference of the suite. */
export const genericHost: Host = localHost("generic")

export const compiledHost: Host = localHost("compiled")

interface Work {
  readonly started: Started
  readonly fiber: Fiber.Fiber<unknown, unknown>
}

/**
 * The smallest host: it plans, runs effects, and routes their outcomes, with one
 * turn at a time. It has no clock, stores nothing, and refuses children.
 */
export const plannedHost: Host = {
  name: "planner only",
  capabilities: {
    invocations: ["Effect"],
    ownedChildren: false,
    commands: false,
    restart: false,
    stop: false,
    emissions: true,
    rejection: false,
    initialState: "AtStart"
  },
  start: Effect.fnUntraced(function*({ input, machine }) {
    const scope = yield* Effect.scope
    const turns = Semaphore.makeUnsafe(1)
    const states: Array<Machine.Machine.EncodedSnapshot> = []
    const emitted: Array<unknown> = []
    let running: Array<Work> = []
    let failure: string | undefined
    let host: PlannedHost

    const fail = (cause: Parameters<typeof renderFailure>[0]) =>
      Effect.suspend(() => {
        failure = renderFailure(cause)
        host.generations.retireAllGenerations()
        return stopRetired
      })

    const stopRetired = Effect.suspend(() => {
      const stopped = running.filter(({ started }) => !started.generation.current)
      running = running.filter(({ started }) => started.generation.current)
      return Fiber.interruptAll(stopped.map(({ fiber }) => fiber))
    })

    /** Publishes what a turn led to, then stops and starts the work it changed. */
    const follow = (planning: () => ReadonlyArray<Started>): Effect.Effect<void> =>
      Effect.matchCauseEffect(Effect.sync(planning), {
        onFailure: fail,
        onSuccess: (starts) =>
          Effect.suspend(() => {
            states.push(encode(machine, host.snapshot))
            emitted.push(...host.takeEmitted())
            return Effect.andThen(stopRetired, Effect.forEach(starts, startOne, { discard: true }))
          })
      })

    const startOne = (started: Started): Effect.Effect<void> =>
      Effect.suspend(() => {
        const { invocation } = started
        if (failure !== undefined) return Effect.void
        if (invocation._tag !== "Effect") return unsupported(invocation._tag)
        return Effect.matchCauseEffect(
          Effect.sync(() => invocation.effect() as Effect.Effect<unknown, unknown>),
          {
            onFailure: fail,
            onSuccess: (effect) =>
              Effect.gen(function*() {
                // A scope of its own, like every resource of a run.
                const fiber = yield* Effect.forkIn(Effect.scoped(effect), scope, { startImmediately: true })
                running.push({ started, fiber })
                yield* Fiber.await(fiber).pipe(
                  Effect.flatMap((exit) => settle(started, exit)),
                  Effect.forkIn(scope, { startImmediately: true })
                )
              })
          }
        )
      })

    const settle = (started: Started, exit: Exit.Exit<unknown, unknown>): Effect.Effect<void> =>
      Semaphore.withPermit(turns)(Effect.suspend(() => {
        const decision = decide(started, InvocationOutcome.fromExit(exit))
        switch (decision._tag) {
          case "Deliver":
            return follow(() => host.send(decision.event))
          case "Fail":
            return fail(decision.cause)
          case "Ignore":
            return Effect.void
        }
      }))

    const initial = yield* Effect.exit(Effect.sync(() => new PlannedHost(machine, ...input)))
    if (Exit.isFailure(initial)) {
      const outcome: Outcome = { _tag: "Failed", failure: renderFailure(initial.cause) }
      return {
        states,
        emitted,
        current: () => undefined,
        send: () => Effect.succeed("Ended" as const),
        outcome: Effect.succeed(outcome),
        stop: unsupported("Stop"),
        restart: () => unsupported("Restart")
      }
    }
    host = initial.value
    // Planned in a later turn, as a local machine does.
    host.deliver = (event) =>
      Effect.asVoid(Effect.forkIn(Semaphore.withPermit(turns)(follow(() => host.send(event as object))), scope))
    yield* Semaphore.withPermit(turns)(follow(() => host.started))

    return {
      states,
      emitted,
      current: () => states.at(-1),
      send: (event) =>
        Semaphore.withPermit(turns)(Effect.suspend(() =>
          failure !== undefined || host.ending !== undefined
            ? Effect.succeed("Ended" as const)
            : Effect.as(follow(() => host.send(event)), "Accepted" as const)
        )),
      outcome: Effect.sync((): Outcome => {
        if (failure !== undefined) return { _tag: "Failed", failure }
        if (host.ending === undefined) return { _tag: "Running" }
        return host.ending.output === undefined ? { _tag: "Final" } : { _tag: "Final", output: host.ending.output }
      }),
      stop: unsupported("Stop"),
      restart: () => unsupported("Restart")
    }
  })
}
