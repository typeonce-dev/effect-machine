/**
 * The outside world of one scenario run: the work its machine invokes, which the
 * script ends, and the records its model code leaves.
 */
import { Cause, Deferred, Effect, Exit, Queue, Stream } from "effect"
import { Machine } from "../../../src/index.js"

/** The typed failure of every source of a fixture. */
export interface Failure {
  readonly reason: string
}

/** One run of invoked work. */
export interface Run {
  readonly source: string
  /** `source(input)`, or the source alone when it takes no input. */
  readonly label: string
  readonly result: Deferred.Deferred<any, Failure>
  readonly elements: Queue.Queue<any, Failure | Cause.Done>
  /** Whether the script ended the work while it ran. */
  ended: boolean
  /** How the fiber of the work ended, once it has. */
  exit: Exit.Exit<unknown, unknown> | undefined
}

export interface Options {
  /** Work that does not end when its host interrupts it, until the script does. */
  readonly uninterruptible?: boolean
}

const labelOf = (source: string, input: unknown): string =>
  input === undefined ? source : `${source}(${typeof input === "string" ? input : JSON.stringify(input)})`

/** The name of a lifecycle event. */
const eventName = (event: { readonly _tag: PropertyKey }): string =>
  Machine.isInitialEvent(event)
    ? "initial"
    : Machine.isInvocationEvent(event)
    ? `${event.kind} of ${event.path}/${event.id}`
    : String(event._tag)

export class Fixture {
  readonly runs: Array<Run> = []
  readonly log: Array<string> = []

  /** Called synchronously when a run starts. */
  onStart: (run: Run) => void = () => {}

  /** Records that model code ran. */
  readonly note = (text: string): undefined => {
    this.log.push(text)
    return undefined
  }

  /** Records that an input mapper ran for a lifecycle event, and returns its input. */
  readonly mapped = <A>(name: string, event: { readonly _tag: PropertyKey }, input: A): A => {
    this.note(`${name} by ${eventName(event)}`)
    return input
  }

  private begin(source: string, input: unknown): Run {
    const run: Run = {
      source,
      label: labelOf(source, input),
      result: Deferred.makeUnsafe(),
      elements: Effect.runSync(Queue.unbounded<any, Failure | Cause.Done>()),
      ended: false,
      exit: undefined
    }
    this.runs.push(run)
    this.onStart(run)
    return run
  }

  private readonly during = <A, E, R>(
    source: string,
    input: unknown,
    work: (run: Run) => Effect.Effect<A, E, R>
  ): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const run = this.begin(source, input)
      return Effect.onExit(work(run), (exit) =>
        Effect.sync(() => {
          run.exit = exit
        }))
    })

  /** Work that runs until the script ends it. */
  readonly work = (source: string, input?: unknown, options?: Options): Effect.Effect<string, Failure> =>
    this.during(source, input, (run) => {
      const result = Deferred.await(run.result) as Effect.Effect<string, Failure>
      return options?.uninterruptible === true ? Effect.uninterruptible(result) : result
    })

  /** Work that ends as it starts, without suspending. */
  readonly instant = <A, E>(source: string, effect: Effect.Effect<A, E>, input?: unknown): Effect.Effect<A, E> =>
    this.during(source, input, () => effect)

  /** A stream whose elements and end the script chooses. */
  readonly stream = (source: string, input?: unknown): Stream.Stream<any, Failure> =>
    Stream.unwrap(
      Effect.map(
        Effect.acquireRelease(Effect.sync(() => this.begin(source, input)), (run, exit) =>
          Effect.sync(() => {
            run.exit = exit
          })),
        (run) => Stream.fromQueue(run.elements)
      )
    )

  /** The newest run of a source, or an earlier one by its position. */
  find(source: string, position?: number): Run {
    const runs = this.runs.filter((run) => run.source === source)
    const run = position === undefined ? runs.at(-1) : runs[position]
    if (run === undefined) throw new Error(`Source "${source}" has no run ${position ?? ""}`)
    return run
  }
}

/** Whether the host stopped a run, before the script ended it. */
export const wasStopped = ({ ended, exit }: Run): boolean =>
  !ended && exit !== undefined && Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
