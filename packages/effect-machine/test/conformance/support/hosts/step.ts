import { Cause, Effect, Exit, Fiber, Scope, Semaphore, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Machine } from "../../../../src/index.js"
import type { Answer, Host, Outcome } from "../host.js"
import { decode, encode, renderFailure } from "../host.js"

/** A step function whose machine type does not matter to the suite. */
type AnyStep = Machine.MachineStep<any>

type Step = Machine.MachineStep.Step<any>

type Work = Machine.MachineStep.Work<any>

const isStopped = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.length > 0 &&
  cause.reasons.every((reason) => Cause.isFailReason(reason) && reason.error instanceof Machine.StoppedError)

/**
 * A host written only against `Machine.toStep`. It keeps the state value, runs
 * the work a step starts, and reports how that work ended, one turn at a time.
 * It restarts from the encoded snapshot, which is what an application can
 * store.
 */
export const stepHost: Host = {
  name: "Machine.toStep",
  capabilities: {
    invocations: ["Effect", "Timer", "Stream"],
    ownedChildren: false,
    commands: true,
    restart: true,
    stop: true,
    emissions: true,
    rejection: true,
    initialState: "AtStart"
  },
  start: Effect.fnUntraced(function*({ input, machine }) {
    const outer = yield* Effect.scope
    const turns = Semaphore.makeUnsafe(1)
    const states: Array<Machine.Machine.EncodedSnapshot> = []
    const emitted: Array<unknown> = []

    /** One life of the host. A restart ends it, with every fiber it forked. */
    interface Life {
      readonly scope: Scope.Closeable
      readonly running: Map<Work, Fiber.Fiber<unknown, unknown>>
      state: Machine.MachineStep.State<any> | undefined
      startFailure: string | undefined
      exit: Step["exit"]
    }
    let life: Life

    const turn = <A>(effect: Effect.Effect<A>): Effect.Effect<A> => Semaphore.withPermit(turns)(effect)

    const self: Machine.MachineTarget<unknown> = {
      id: machine.id ?? "Machine",
      sessionId: `${machine.id ?? "Machine"}:step`,
      // Planned in a later turn, as a local machine does.
      send: (event) =>
        Effect.suspend(() =>
          life.exit !== undefined
            ? Effect.fail(new Machine.StoppedError())
            : Effect.asVoid(Effect.forkIn(turn(takeEvent(life, event as object)), life.scope))
        )
    }
    const step: AnyStep = Machine.toStep(machine as never, { self })

    /** Carries out what one step says, in the order it is given in. */
    const carryOut = (current: Life, done: Step): Effect.Effect<void> =>
      Effect.gen(function*() {
        current.state = done.state
        current.exit = done.exit
        for (const { event, target } of done.sends) {
          yield* Effect.ignore(target.send(event))
        }
        const stopped = done.stop.flatMap((work) => {
          const fiber = current.running.get(work)
          current.running.delete(work)
          return fiber === undefined ? [] : [fiber]
        })
        yield* Fiber.interruptAll(stopped)
        states.push(encode(machine, done.snapshot))
        emitted.push(...done.emitted)
        for (const work of done.start) yield* run(current, work)
      })

    const run = (current: Life, work: Work): Effect.Effect<void> =>
      Effect.gen(function*() {
        const running = work._tag === "Effect"
          ? work.effect
          : work._tag === "Timer"
          ? Effect.sleep(work.duration)
          : Stream.runForEach(work.stream, (element) =>
            // Taken in a turn of its own, which may stop this stream, and the
            // next element is pulled once it is taken.
            Effect.flatMap(
              Effect.forkIn(
                turn(Effect.suspend(() => carryOut(current, step.element(current.state!, work, element)))),
                current.scope,
                { startImmediately: true }
              ),
              Fiber.join
            ))
        const fiber = yield* Effect.forkIn(running as Effect.Effect<unknown, unknown>, current.scope, {
          startImmediately: true
        })
        current.running.set(work, fiber)
        yield* Fiber.await(fiber).pipe(
          Effect.flatMap((exit) =>
            turn(Effect.suspend(() => {
              // The step ignores work that it stopped, so the host only forgets the fiber.
              current.running.delete(work)
              return carryOut(current, step.settle(current.state!, work, exit))
            }))
          ),
          Effect.forkIn(current.scope, { startImmediately: true })
        )
      })

    const takeEvent = (current: Life, event: object): Effect.Effect<Answer> =>
      Effect.suspend(() => {
        if (current.state === undefined || current.exit !== undefined) return Effect.succeed("Ended" as const)
        const result = step.send(current.state, event)
        if (Exit.isSuccess(result)) return Effect.as(carryOut(current, result.value), "Accepted" as const)
        return Effect.succeed(isStopped(result.cause) ? "Ended" as const : "Rejected" as const)
      })

    const open = Effect.fnUntraced(function*(starting: () => Exit.Exit<Step, unknown>) {
      const current: Life = {
        scope: yield* Scope.fork(outer),
        running: new Map(),
        state: undefined,
        startFailure: undefined,
        exit: undefined
      }
      life = current
      const started = starting()
      if (Exit.isFailure(started)) {
        current.startFailure = renderFailure(started.cause)
        return
      }
      yield* turn(carryOut(current, started.value))
    })

    // The suite passes the decoded input of a machine that declares one.
    yield* open(() => step.start(...(input as [])))

    return {
      states,
      emitted,
      // The state that a step publishes holds until the next one, also while its
      // work starts.
      current: () => life.state === undefined ? undefined : states.at(-1),
      send: (event) => turn(takeEvent(life, event)),
      outcome: Effect.sync((): Outcome => {
        if (life.startFailure !== undefined) return { _tag: "Failed", failure: life.startFailure }
        const exit = life.exit
        if (exit === undefined) return { _tag: "Running" }
        if (Exit.isSuccess(exit)) {
          return exit.value === undefined
            ? { _tag: "Final" }
            : { _tag: "Final", output: exit.value }
        }
        return isStopped(exit.cause) ? { _tag: "Stopped" } : { _tag: "Failed", failure: renderFailure(exit.cause) }
      }),
      stop: turn(Effect.suspend(() => life.state === undefined ? Effect.void : carryOut(life, step.stop(life.state)))),
      restart: Effect.fnUntraced(function*(downtimeMillis) {
        if (life.state === undefined) return
        const stored = states.at(-1)!
        yield* Scope.close(life.scope, Exit.void)
        yield* TestClock.adjust(downtimeMillis)
        yield* open(() => step.resume(decode(machine, stored)))
      })
    }
  })
}
