/**
 * The invoked effects that one live Cluster instance runs.
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
import { ProcessLocalError } from "./errors.js"
import * as InvocationDefinition from "./invocationDefinition.js"
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
export const makeCapabilities = (machineId: string): InvocationResolution.InvocationCapabilities => ({
  self: new HostedTarget(machineId),
  parent: undefined,
  children: refusedChildren
})

/** @internal */
export const sameKey = (left: Checkpoint.InvocationKey, right: Checkpoint.InvocationKey): boolean =>
  left.path === right.path && left.id === right.id

/**
 * One effect this host runs, from its start until its outcome is applied or its
 * state exits.
 *
 * @internal
 */
export interface Work {
  readonly invocation: InvocationResolution.EffectInvocation
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

/** @internal */
export interface Options<R> {
  readonly machineId: string
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
 * Owns every fiber that runs work, the fibers that report how it ended, and the
 * generations of invoking states. All fibers live in one private scope that only
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

  /** Forks an effect that ends with this work. */
  fork(effect: Effect.Effect<void, never, R>): Effect.Effect<Fiber.Fiber<void>> {
    return Effect.forkIn(Effect.setContext(effect, this.options.context), this.scope, { startImmediately: true })
  }

  /**
   * Starts groups in order, one generation per group, leaving out settled
   * invocations. The first source that cannot be constructed ends the start.
   */
  readonly start = Effect.fnUntraced(function*<R>(
    this: ClusterWork<R>,
    groups: ReadonlyArray<InvocationResolution.InvocationGroup>,
    settled: ReadonlyArray<Checkpoint.InvocationKey>
  ): Effect.fn.Return<StartFailure | undefined> {
    for (const group of groups) {
      if (this.isClosed) return undefined
      const generation = this.generations.beginGeneration(group.path)
      for (const invocation of group.invocations) {
        if (settled.some((key) => sameKey(key, invocation))) continue
        const exit = yield* Effect.exit(Effect.sync(() => construct(invocation)))
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
    invocation: InvocationResolution.EffectInvocation,
    effect: Effect.Effect<unknown, unknown, unknown>,
    generation: Generation
  ): Effect.Effect<void> {
    const { address, context, machineId, onEnd } = this.options
    const hosted = Effect.suspend(() => effect).pipe(
      Effect.scoped,
      Effect.withSpan("Machine.invoke", {
        attributes: {
          "machine.id": machineId,
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

const construct = (invocation: InvocationResolution.ResolvedInvocation) => {
  if (invocation._tag !== "Effect") {
    throw new Error(`Unexpected ${invocation._tag} invocation "${invocation.id}" of a supported machine`)
  }
  return { invocation, effect: invocation.effect() }
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
  /** Every invocation of the machine is an effect. */
  | { readonly _tag: "Effects" }
  | { readonly _tag: "Unsupported"; readonly message: string }

const sourceKind = (definition: InvocationDefinition.InvocationDefinition): string | undefined => {
  if ("effect" in definition) return undefined
  if ("after" in definition) return "Timer"
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
    for (const definition of InvocationDefinition.definitions(handlers[path]?.invoke)) {
      const kind = sourceKind(definition)
      if (kind !== undefined) {
        const id = InvocationDefinition.lifecycleId(definition)
        return {
          _tag: "Unsupported",
          message: `${kind} invocation "${id}" of state "${path}" is process-local and is not supported`
        }
      }
      support = { _tag: "Effects" }
    }
  }
  return support
}
