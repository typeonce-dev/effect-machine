/**
 * The invocations that one live Cluster instance runs: effects, and timers that
 * wait for their stored due time.
 *
 * @since 0.48.0
 */
import * as Cause from "effect/Cause"
import type { EntityAddress } from "effect/cluster"
import type * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Scope from "effect/Scope"
import type { ChildOwner, MachineTarget } from "../../Machine.js"
import type { Checkpoint } from "../../unstable/cluster/ClusterMachine.js"
import * as CapturedInvocation from "./capturedInvocation.js"
import * as ClusterProgress from "./clusterProgress.js"
import * as ClusterTimer from "./clusterTimer.js"
import { ProcessLocalError } from "./errors.js"
import type { Generation } from "./invocationEvent.js"
import { InvocationGenerations } from "./invocationGeneration.js"
import type * as InvocationOutcome from "./invocationOutcome.js"
import * as InvocationResolution from "./invocationResolution.js"

type EntityAddress = EntityAddress.EntityAddress

const refuse = (operation: string): Effect.Effect<never> => Effect.die(new ProcessLocalError({ operation }))

/**
 * A Cluster machine has no local process, so it has no session id, and events
 * sent through a local target are not durable. Reading either one is a defect of
 * the work that reads it.
 */
class HostedTarget implements MachineTarget<any> {
  constructor(readonly id: string) {}

  get sessionId(): string {
    throw new ProcessLocalError({ operation: "self.sessionId" })
  }

  readonly send = (_event: unknown) => refuse("self.send")
}

const refusedChildren: ChildOwner<any> = {
  spawn: () => refuse("children.spawn"),
  sendTo: () => refuse("children.sendTo"),
  stop: () => refuse("children.stop")
}

/**
 * Capabilities of a Cluster host. Its machine has no parent, and refuses every
 * operation that needs a local process.
 *
 * @internal
 */
export const makeCapabilities = (definitionId: string): InvocationResolution.InvocationCapabilities => ({
  self: new HostedTarget(definitionId),
  parent: undefined,
  children: refusedChildren
})

/** An invocation this host runs. */
type HostedInvocation = InvocationResolution.EffectInvocation | InvocationResolution.TimerInvocation

const sameKey = (left: Checkpoint.InvocationKey, right: Checkpoint.InvocationKey): boolean =>
  left.path === right.path && left.id === right.id

/**
 * One invocation this host runs, from its start until its outcome is applied or
 * its state exits. A timer is work whose fiber waits, so everything that stops,
 * retires, or reports work holds for it too.
 *
 * @internal
 */
export interface Work {
  readonly invocation: HostedInvocation
  readonly generation: Generation
  readonly fiber: Fiber.Fiber<unknown, unknown>

  /**
   * Whether this host stopped the work. Set before its fiber is interrupted, so
   * no interruption the host caused is read as an outcome.
   */
  stopped: boolean
}

/**
 * Why an invocation could not start.
 *
 * @internal
 */
export interface StartFailure {
  readonly key: Checkpoint.InvocationKey
  readonly cause: Cause.Cause<never>
}

/**
 * What a stored state says about the work it owns.
 *
 * @internal
 */
export type Stored = ClusterTimer.Schedule

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
  readonly onEnd: (work: Work, exit: Exit.Exit<unknown, unknown>) => Effect.Effect<void, never, R>
}

/**
 * Owns every fiber that runs work, including the waits of timers, the fibers that
 * report how it ended, and the generations of invoking states. All fibers live in
 * one private scope that only `close` closes, so `close` can declare the work
 * stopped before the first interruption reaches it.
 *
 * Nothing here is synchronized. Every method except `close` runs inside a turn
 * of the instance.
 *
 * @internal
 */
export class ClusterWork<R> {
  /**
   * Stored revision that the running work belongs to. `undefined` means the work
   * matches no revision, so the next state starts it from the beginning.
   */
  revision: number | undefined = undefined

  private readonly scope = Scope.makeUnsafe("parallel")
  private readonly generations = new InvocationGenerations()
  private readonly running = new Map<string, Array<Work>>()
  private isClosed = false

  constructor(private readonly options: Options<R>) {}

  /** Whether the instance that owns this work is gone. */
  get closed(): boolean {
    return this.isClosed
  }

  /** Whether an outcome that has not been applied is still expected. */
  get pending(): boolean {
    return this.running.size > 0
  }

  /** Whether some work whose outcome is still expected is not left out. */
  pendingExcept(leftOut: (work: Work) => boolean): boolean {
    for (const works of this.running.values()) {
      if (works.some((work) => !leftOut(work))) return true
    }
    return false
  }

  /** Forks an effect that ends with this work. */
  fork(effect: Effect.Effect<void, never, R>): Effect.Effect<Fiber.Fiber<void>> {
    return Effect.forkIn(Effect.setContext(effect, this.options.context), this.scope, { startImmediately: true })
  }

  /**
   * Starts groups in order, one generation per group, leaving out settled
   * invocations. A timer waits for its stored due time, or ends at once when that
   * has passed. The first source that cannot be constructed ends the start.
   */
  readonly start = Effect.fnUntraced(function*<R>(
    this: ClusterWork<R>,
    groups: ReadonlyArray<InvocationResolution.InvocationGroup>,
    stored: Stored
  ): Effect.fn.Return<StartFailure | undefined> {
    for (const group of groups) {
      if (this.isClosed) return undefined
      const generation = this.generations.beginGeneration(group.path)
      for (const invocation of group.invocations) {
        if (ClusterProgress.get(stored.progress, invocation)?._tag === "Settled") continue
        const exit = yield* Effect.exit(construct(invocation, stored))
        if (Exit.isFailure(exit)) {
          return { key: { path: invocation.path, id: invocation.id }, cause: exit.cause }
        }
        yield* this.run(exit.value.invocation, exit.value.effect, generation)
      }
    }
    return undefined
  })

  /** Stops the work of exited paths and retires their generations. */
  stopPaths(paths: ReadonlyArray<string>): Effect.Effect<void> {
    return Effect.suspend(() => {
      this.generations.retireGenerations(paths)
      const stopped: Array<Work> = []
      for (const path of paths) {
        stopped.push(...this.running.get(path) ?? [])
        this.running.delete(path)
      }
      return this.interrupt(stopped)
    })
  }

  /** Stops all work and retires every generation. */
  readonly stopAll: Effect.Effect<void> = Effect.suspend(() => this.interrupt(this.takeAll()))

  /** Removes work whose outcome was applied. */
  settle(work: Work): void {
    const path = work.invocation.path
    const remaining = this.running.get(path)?.filter((running) => running !== work)
    if (remaining === undefined || remaining.length === 0) {
      this.running.delete(path)
    } else {
      this.running.set(path, remaining)
    }
  }

  /**
   * Stops everything when the instance ends. The work is declared stopped, and
   * the instance closed, before any fiber is interrupted.
   */
  readonly close: Effect.Effect<void> = Effect.suspend(() => {
    this.isClosed = true
    for (const work of this.takeAll()) work.stopped = true
    return Scope.close(this.scope, Exit.void)
  })

  private takeAll(): ReadonlyArray<Work> {
    this.generations.retireAllGenerations()
    const all = Array.from(this.running.values()).flat()
    this.running.clear()
    return all
  }

  private interrupt(stopped: ReadonlyArray<Work>): Effect.Effect<void> {
    for (const work of stopped) work.stopped = true
    return stopped.length === 0 ? Effect.void : Fiber.interruptAll(stopped.map((work) => work.fiber))
  }

  private run(
    invocation: HostedInvocation,
    effect: Effect.Effect<unknown, unknown, unknown>,
    generation: Generation
  ): Effect.Effect<void> {
    const { address, context, definitionId, onEnd } = this.options
    const hosted = Effect.suspend(() => effect).pipe(
      Effect.scoped,
      Effect.withSpan("Machine.invoke", {
        attributes: {
          "machine.id": definitionId,
          "machine.state.path": invocation.path,
          "machine.invoke.id": invocation.id,
          "machine.invoke.source": invocation.sourceName ?? invocation.id,
          "machine.invoke.kind": invocation._tag,
          "entity.type": address.entityType,
          "entity.id": address.entityId
        }
      }, { captureStackTrace: false })
      // The public machine type owns the services of its invoked effects, which
      // the adapter requires. They are erased in captured definitions.
    ) as Effect.Effect<unknown, unknown, R>
    return Effect.forkIn(Effect.setContext(hosted, context), this.scope, { startImmediately: true }).pipe(
      Effect.flatMap((fiber) => {
        const work: Work = { invocation, generation, fiber, stopped: false }
        const running = this.running.get(invocation.path)
        if (running === undefined) {
          this.running.set(invocation.path, [work])
        } else {
          running.push(work)
        }
        return this.fork(
          Effect.flatMap(Fiber.await(fiber), (exit) => work.stopped ? Effect.void : onEnd(work, exit))
        )
      }),
      Effect.asVoid
    )
  }
}

interface Constructed {
  readonly invocation: HostedInvocation
  readonly effect: Effect.Effect<unknown, unknown, unknown>
}

// The duration of a timer was evaluated before its state was stored. A failure
// of that is reported here, where the local runtime would have evaluated it.
const constructTimer = (
  invocation: InvocationResolution.TimerInvocation,
  { progress, unscheduled }: Stored
): Effect.Effect<Constructed> => {
  const waiting = ClusterProgress.get(progress, invocation)
  if (waiting?._tag === "Waiting") {
    return Effect.succeed({ invocation, effect: ClusterTimer.waitUntil(waiting.dueAt) })
  }
  const failed = unscheduled.find(({ key }) => sameKey(key, invocation))
  if (failed === undefined) {
    return Effect.die(new Error(`Timer "${invocation.id}" of state "${invocation.path}" has no due time`))
  }
  return failed.stage === "Source"
    ? Effect.failCause(failed.cause)
    : Effect.succeed({ invocation, effect: Effect.failCause(failed.cause) })
}

const construct = (
  invocation: InvocationResolution.ResolvedInvocation,
  stored: Stored
): Effect.Effect<Constructed> => {
  switch (invocation._tag) {
    case "Effect":
      return Effect.sync(() => ({ invocation, effect: invocation.effect() }))
    case "Timer":
      return constructTimer(invocation, stored)
    case "Stream":
    case "Logic":
    case "Child":
      return Effect.die(
        new Error(`Unexpected ${invocation._tag} invocation "${invocation.id}" of a supported machine`)
      )
  }
}

/**
 * How work ended. Work that its host stopped reports nothing else, whatever its
 * fiber ended with.
 *
 * @internal
 */
export const outcomeOf = (work: Work, outcome: InvocationOutcome.Outcome): InvocationOutcome.Outcome =>
  work.stopped ? { _tag: "Stopped" } : outcome

/** What a machine asks of its host. */
export type Support =
  /** The machine invokes nothing. */
  | { readonly _tag: "Idle" }
  /** Every invocation of the machine is an effect or a timer. */
  | { readonly _tag: "Hosted" }
  | { readonly _tag: "Unsupported"; readonly message: string }

const unsupportedKind = (definition: CapturedInvocation.CapturedInvocation): string | undefined => {
  if ("effect" in definition || "after" in definition) return undefined
  if ("stream" in definition) return "Stream"
  if ("logic" in definition) return "Logic"
  return "Child"
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
