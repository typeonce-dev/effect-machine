/**
 * The work that one live Cluster instance runs: effects, and timers that wait
 * for their stored due time. Which work runs, stops, and starts is what
 * `Machine.toStep` says. This module only runs it.
 *
 * @since 0.48.0
 */
import type { EntityAddress } from "effect/cluster"
import type * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Scope from "effect/Scope"
import * as CapturedInvocation from "./capturedInvocation.js"
import * as ClusterProgress from "./clusterProgress.js"
import * as ClusterTimer from "./clusterTimer.js"
import type * as Step from "./step.js"

type EntityAddress = EntityAddress.EntityAddress

/**
 * One piece of work that this host runs on a fiber, from its start until its
 * outcome is applied or the host stops it.
 *
 * @internal
 */
export interface Running {
  readonly work: Step.Work
  readonly fiber: Fiber.Fiber<unknown, unknown>

  /**
   * Whether this host stopped the work. Set before its fiber is interrupted, so
   * no interruption the host caused is read as an outcome.
   */
  stopped: boolean
}

/**
 * Work that could not start: the failed `Exit` of the accessor that evaluated
 * it, which the host settles it with.
 *
 * @internal
 */
export interface StartFailure {
  readonly work: Step.Work
  readonly exit: Exit.Exit<unknown, unknown>
}

/** @internal */
export interface Options<R> {
  readonly definitionId: string
  readonly address: EntityAddress

  /** Services of every work fiber, whatever started it. */
  readonly context: Context.Context<R>

  /**
   * Called in a fiber of its own once work that was not stopped has ended. It
   * may start before the turn that started the work has finished.
   */
  readonly onEnd: (running: Running, exit: Exit.Exit<unknown, unknown>) => Effect.Effect<void, never, R>
}

/**
 * Owns every fiber that runs work, including the waits of timers and the fibers
 * that report how it ended. All fibers live in one private scope that only
 * `close` closes, so `close` can declare the work stopped before the first
 * interruption reaches it.
 *
 * Nothing here is synchronized. Every method except `close` runs inside a turn
 * of the instance.
 *
 * @internal
 */
export class ClusterWork<R> {
  /**
   * The stored revision that the running work belongs to, with the step state
   * that lists it. `undefined` means the work matches no revision, so the next
   * state starts it from the beginning.
   */
  current: { readonly revision: number; readonly state: Step.State } | undefined = undefined

  private readonly scope = Scope.makeUnsafe("parallel")
  private readonly running = new Map<Step.Work, Running>()
  private isClosed = false

  constructor(private readonly options: Options<R>) {}

  /** Whether the instance that owns this work is gone. */
  get closed(): boolean {
    return this.isClosed
  }

  /** Whether some work whose outcome is still expected is not left out. */
  pendingExcept(leftOut: (running: Running) => boolean): boolean {
    for (const running of this.running.values()) {
      if (!leftOut(running)) return true
    }
    return false
  }

  /** Forks an effect that ends with this work. */
  fork(effect: Effect.Effect<void, never, R>): Effect.Effect<Fiber.Fiber<void>> {
    return Effect.forkIn(Effect.setContext(effect, this.options.context), this.scope, { startImmediately: true })
  }

  /**
   * Starts work in order, evaluating each piece when it starts. A child machine
   * runs as an entity of its own, which the step that entered its state
   * started. A timer waits for its stored due time, or ends at once when that
   * has passed. The first work that cannot start ends the start.
   */
  readonly start = Effect.fnUntraced(function*<R>(
    this: ClusterWork<R>,
    works: ReadonlyArray<Step.Work>,
    progress: ClusterProgress.Progress
  ): Effect.fn.Return<StartFailure | undefined> {
    for (const work of works) {
      if (this.isClosed) return undefined
      const constructed = construct(work, progress)
      if (constructed === undefined) continue
      if (Exit.isFailure(constructed)) return { work, exit: constructed }
      yield* this.run(work, constructed.value)
    }
    return undefined
  })

  /** Stops the work that runs among `works`, together. */
  stop(works: ReadonlyArray<Step.Work>): Effect.Effect<void> {
    return Effect.suspend(() => {
      const stopped: Array<Running> = []
      for (const work of works) {
        const running = this.running.get(work)
        if (running === undefined) continue
        this.running.delete(work)
        stopped.push(running)
      }
      return this.interrupt(stopped)
    })
  }

  /** Stops all work, which then belongs to no revision. */
  readonly stopAll: Effect.Effect<void> = Effect.suspend(() => {
    this.current = undefined
    return this.interrupt(this.takeAll())
  })

  /** Removes work whose outcome was applied. */
  settle(running: Running): void {
    if (this.running.get(running.work) === running) this.running.delete(running.work)
  }

  /**
   * Stops everything when the instance ends. The work is declared stopped, and
   * the instance closed, before any fiber is interrupted.
   */
  readonly close: Effect.Effect<void> = Effect.suspend(() => {
    this.isClosed = true
    for (const running of this.takeAll()) running.stopped = true
    return Scope.close(this.scope, Exit.void)
  })

  private takeAll(): ReadonlyArray<Running> {
    const all = Array.from(this.running.values())
    this.running.clear()
    return all
  }

  private interrupt(stopped: ReadonlyArray<Running>): Effect.Effect<void> {
    for (const running of stopped) running.stopped = true
    return stopped.length === 0 ? Effect.void : Fiber.interruptAll(stopped.map((running) => running.fiber))
  }

  private run(work: Step.Work, effect: Effect.Effect<unknown, unknown, unknown>): Effect.Effect<void> {
    const { address, context, definitionId, onEnd } = this.options
    const hosted = Effect.suspend(() => effect).pipe(
      Effect.withSpan("Machine.invoke", {
        attributes: {
          "machine.id": definitionId,
          "machine.state.path": work.path,
          "machine.invoke.id": work.id,
          "machine.invoke.source": work.source ?? work.id,
          "machine.invoke.kind": work._tag,
          "entity.type": address.entityType,
          "entity.id": address.entityId
        }
      }, { captureStackTrace: false })
      // The public machine type owns the services of its invoked effects, which
      // the adapter requires. They are erased in the step.
    ) as Effect.Effect<unknown, unknown, R>
    return Effect.forkIn(Effect.setContext(hosted, context), this.scope, { startImmediately: true }).pipe(
      Effect.flatMap((fiber) => {
        const running: Running = { work, fiber, stopped: false }
        this.running.set(work, running)
        return this.fork(
          Effect.flatMap(Fiber.await(fiber), (exit) => running.stopped ? Effect.void : onEnd(running, exit))
        )
      }),
      Effect.asVoid
    )
  }
}

/**
 * The effect that runs a piece of work, a failed `Exit` when it cannot start,
 * or `undefined` for work that runs elsewhere.
 */
const construct = (
  work: Step.Work,
  progress: ClusterProgress.Progress
): Exit.Exit<Effect.Effect<unknown, unknown, unknown>, unknown> | undefined => {
  switch (work._tag) {
    case "Effect":
      return work.effect()
    case "Timer": {
      const waiting = ClusterProgress.get(progress, work)
      if (waiting?._tag === "Waiting") return Exit.succeed(ClusterTimer.waitUntil(waiting.dueAt))
      // The duration was read before the state was stored. A failure of that
      // is reported here, where the local runtime would have read it.
      const duration = work.duration()
      if (Exit.isFailure(duration)) return duration
      return Exit.isFailure(duration.value)
        ? Exit.succeed(Effect.failCause(duration.value.cause))
        : Exit.die(new Error(`Timer "${work.id}" of state "${work.path}" has no due time`))
    }
    case "Child":
      return undefined
    case "Stream":
    case "Logic":
      return Exit.die(new Error(`Unexpected ${work._tag} invocation "${work.id}" of a supported machine`))
  }
}

/** What a machine asks of its host. */
export type Support =
  /** The machine invokes nothing. */
  | { readonly _tag: "Idle" }
  /** Every invocation of the machine is an effect, a timer, or a child machine. */
  | { readonly _tag: "Hosted" }
  | { readonly _tag: "Unsupported"; readonly message: string }

const unsupportedKind = (definition: CapturedInvocation.CapturedInvocation): string | undefined => {
  if ("effect" in definition || "after" in definition || "child" in definition) return undefined
  if ("stream" in definition) return "Stream"
  return "Logic"
}

/**
 * Decides for the whole machine, before it runs, so that no step can drive it
 * into a state this host cannot run.
 *
 * @internal
 */
export const supportOf = (handlers: Readonly<Record<string, { readonly invoke?: unknown } | undefined>>): Support => {
  let support: Support = { _tag: "Idle" }
  for (const path of Object.keys(handlers)) {
    for (const definition of CapturedInvocation.list(handlers[path]?.invoke)) {
      const kind = unsupportedKind(definition)
      if (kind !== undefined) {
        const id = CapturedInvocation.lifecycleId(definition)
        return {
          _tag: "Unsupported",
          message: `${kind} invocation "${id}" of state "${path}" is process-local and is not supported`
        }
      }
      support = { _tag: "Hosted" }
    }
  }
  return support
}
