/**
 * A scenario is a machine and a script, with what every host must do at each
 * step of it.
 */
import { Cause, type Duration, Exit } from "effect"
import type { Answer, MakeMachine, Outcome } from "./host.js"

/**
 * A settled state: the fields of each active state, by path.
 *
 * An active state without fields is left out when an active descendant implies
 * it, and the tag of a state is left out because its path says the same.
 */
export type State = Readonly<Record<string, object>>

/** A settled state, or the start of work, as {@link started} names it. */
export type Happening = State | string

/**
 * The plain value of a public event. The constructors of an event protocol
 * return inputs that only some hosts take.
 */
export type Event = object & { readonly _tag: string }

/** One thing the script does from outside the host. */
export type Action =
  | { readonly _tag: "Send"; readonly event: Event }
  /** Ends a run of controlled work, the newest one unless `run` names another. */
  | {
    readonly _tag: "End"
    readonly source: string
    readonly exit: Exit.Exit<unknown, { readonly reason: string }>
    readonly run: number | undefined
  }
  /** Offers an element to a controlled stream, or ends it. */
  | { readonly _tag: "Element"; readonly source: string; readonly value: unknown; readonly run: number | undefined }
  | { readonly _tag: "Advance"; readonly duration: Duration.Input }
  | { readonly _tag: "Restart"; readonly downtimeMillis: number }
  | { readonly _tag: "Stop" }

/** What a step of a script leads to. Whatever it leaves out must not happen. */
export interface Expectation {
  /** Answers to the events sent, all `Accepted` when left out. */
  readonly answers?: ReadonlyArray<Answer>

  /**
   * States the machine settled in, and work that started, in order. Work comes
   * after the state that owns it, because a host starts no work for a state it
   * has not published or stored.
   */
  readonly happens?: ReadonlyArray<Happening>

  /** Work the host stopped, in any order. */
  readonly stopped?: ReadonlyArray<string>

  /** What the model code recorded, in order. */
  readonly log?: ReadonlyArray<string>

  /** Events the machine emitted, in order. */
  readonly emits?: ReadonlyArray<unknown>

  /** Where the machine stands now. That of the step before when left out. */
  readonly outcome?: Outcome
}

/** One step: some actions, and what everything they cause amounts to. */
export interface Step extends Expectation {
  readonly name: string
  readonly actions: ReadonlyArray<Action>
  /** `false` performs the actions without letting anything happen in between. */
  readonly settled?: false
}

export interface Scenario {
  readonly name: string
  readonly machine: MakeMachine
  readonly input?: unknown

  /** The capabilities that can be read neither from the machine nor from the script. */
  readonly needs?: ReadonlyArray<"OwnedChildren" | "Commands">

  /** What starting the machine leads to, as the step `start`. */
  readonly start: Expectation

  readonly steps: ReadonlyArray<Step>
}

export const started = (source: string, input?: string): string =>
  `start ${source}${input === undefined ? "" : `(${input})`}`

export const running: Outcome = { _tag: "Running" }
export const failed = (failure: string): Outcome => ({ _tag: "Failed", failure })
export const final = (output?: unknown): Outcome => output === undefined ? { _tag: "Final" } : { _tag: "Final", output }

const step = (name: string, actions: ReadonlyArray<Action>, expected: Expectation = {}): Step => ({
  name,
  actions,
  ...expected
})

/** Sends a public event. */
export const send = <const E extends Event>(event: E, expected?: Expectation): Step =>
  step(`send ${event._tag}`, [{ _tag: "Send", event }], expected)

const end = (verb: string, exit: Exit.Exit<unknown, { readonly reason: string }>) =>
(
  source: string,
  expected?: Expectation,
  run?: number
): Step => step(`${source} ${verb}`, [{ _tag: "End", source, exit, run }], expected)

/** Ends work with an output. */
export const succeed = (source: string, output: unknown, expected?: Expectation, run?: number): Step =>
  end("succeeds", Exit.succeed(output))(source, expected, run)

/** Ends work with a typed failure. */
export const fail = (source: string, reason: string, expected?: Expectation, run?: number): Step =>
  end("fails", Exit.fail({ reason }))(source, expected, run)

/** Ends work with a defect. */
export const die = (source: string, defect: unknown, expected?: Expectation, run?: number): Step =>
  end("dies", Exit.die(defect))(source, expected, run)

/** Ends work with an interruption of its own. */
export const interrupt = (source: string, expected?: Expectation): Step =>
  end("interrupts itself", Exit.failCause(Cause.interrupt()))(source, expected)

/** Lets a stream produce an element. */
export const element = (source: string, value: unknown, expected?: Expectation, run?: number): Step =>
  step(`${source} produces ${JSON.stringify(value)}`, [{ _tag: "Element", source, value, run }], expected)

export const advance = (duration: Duration.Input, expected?: Expectation): Step =>
  step(`advance ${JSON.stringify(duration)}`, [{ _tag: "Advance", duration }], expected)

/** Takes the host down and brings it back, with the time that passes between. */
export const restart = (downtimeSeconds: number, expected?: Expectation): Step =>
  step(`restart after ${downtimeSeconds} seconds`, [
    { _tag: "Restart", downtimeMillis: downtimeSeconds * 1000 }
  ], expected)

export const stop = (expected?: Expectation): Step => step("stop", [{ _tag: "Stop" }], expected)

/**
 * Performs steps one after the other and observes them as one, for a script
 * whose hosts may reach the same result in a different order.
 */
export const together = (steps: ReadonlyArray<Step>, expected?: Expectation): Step =>
  step(steps.map(({ name }) => name).join(", then "), steps.flatMap(({ actions }) => actions), expected)

/** Performs steps at once, so the host has all of them before it acts on one. */
export const atOnce = (steps: ReadonlyArray<Step>, expected?: Expectation): Step => ({
  ...together(steps, expected),
  settled: false
})

/** Names a step, for a difference to refer to it when its name is not unique. */
export const named = (name: string, { actions, ...expected }: Step): Step => ({ ...expected, actions, name })
