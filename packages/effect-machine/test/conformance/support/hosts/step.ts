import { Cause, Duration, Effect, Exit, Fiber, Scope, Semaphore, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Machine } from "../../../../src/index.js"
import type { Answer, Host, Outcome } from "../host.js"
import { decode, encode, fiberScheduling, renderFailure } from "../host.js"

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
 *
 * It keeps the timers of its machine itself, as a runtime with timers of its own
 * does: a timer is a due time on a clock of the host, and `advance` fires the
 * timers that fall due, in order. Nothing of a timer sleeps on a fiber or on the
 * `TestClock`.
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
  start: Effect.fnUntraced(function*({ activity, input, machine }) {
    const outer = yield* Effect.scope
    // Effects and streams run on fibers, so the host settles as one on fibers does.
    const { settle } = fiberScheduling(activity)
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

    /** The clock of the host, in milliseconds since it started. */
    let now = 0
    /** Timers that wait, by due time, and in the order they started when due together. */
    const timers: Array<{ readonly due: number; readonly life: Life; readonly work: Work }> = []
    const forget = (work: Work): void => {
      const index = timers.findIndex((timer) => timer.work === work)
      if (index >= 0) timers.splice(index, 1)
    }

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
          forget(work)
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
        const millis = work._tag === "Timer" ? Duration.toMillis(work.duration) : 0
        if (work._tag === "Timer" && millis > 0) {
          // A timer of infinite duration never falls due, so nothing keeps it.
          if (millis === Infinity) return
          const due = now + millis
          const index = timers.findIndex((timer) => timer.due > due)
          timers.splice(index < 0 ? timers.length : index, 0, { due, life: current, work })
          return
        }
        // A timer of zero duration waits for no time, and ends as work that does
        // not suspend does.
        const running = work._tag === "Effect"
          ? work.effect
          : work._tag === "Timer"
          ? Effect.void
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
      // The timers of a life end with it.
      yield* Scope.addFinalizer(
        current.scope,
        Effect.sync(() => {
          for (const timer of timers.filter((timer) => timer.life === current)) forget(timer.work)
        })
      )
      const started = starting()
      if (Exit.isFailure(started)) {
        current.startFailure = renderFailure(started.cause)
        return
      }
      yield* turn(carryOut(current, started.value))
    })

    // The suite passes the decoded input of a machine that declares one.
    yield* open(() => step.start(...(input as [])))

    /** Fires a timer that fell due, in a turn of its own. */
    const fire = (current: Life, work: Work): Effect.Effect<void> =>
      turn(Effect.suspend(() => carryOut(current, step.settle(current.state!, work, Exit.void))))

    const advance = Effect.fnUntraced(function*(duration: Duration.Input) {
      const until = now + Duration.toMillis(Duration.fromInputUnsafe(duration))
      while (timers.length > 0 && timers[0]!.due <= until) {
        const next = timers[0]!
        if (next.due > now) {
          // The test clock moves to the due time before the timer fires, and
          // what wakes on it settles first. Work of the scenario that sleeps
          // until that time has then happened, as it has on a host whose timers
          // wait on the same clock, and work that the timer starts reads the
          // time at which the timer fired. A timer that this stops never fires.
          yield* TestClock.adjust(next.due - now)
          now = next.due
          yield* settle
          continue
        }
        timers.shift()
        yield* fire(next.life, next.work)
        yield* settle
      }
      yield* TestClock.adjust(until - now)
      now = until
    })

    return {
      settle,
      advance,
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
        yield* advance(downtimeMillis)
        yield* open(() => step.resume(decode(machine, stored)))
      })
    }
  })
}
