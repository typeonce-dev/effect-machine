/**
 * What a host must offer to be measured by the conformance suite.
 *
 * A host is anything that runs a machine: `LocalMachine`, `AtomMachine`,
 * `ClusterMachine`. The suite writes each scenario once and runs it on every
 * host, so a scenario never names one. To add a host:
 *
 * 1. Implement {@link Host} in `support/hosts`. A host that needs internals of
 *    the library belongs under `test/internal/machine/support` instead.
 * 2. Declare its {@link Capabilities}. They are the only reason for which a
 *    scenario does not run on a host, so declare what the host can do, and not
 *    what it does well. A scenario states no capability of its own where the
 *    suite can read it from the machine or from the script.
 * 3. Add it to `hosts` in `HostConformance.test.ts`, run the suite, and read the
 *    matrix it asserts.
 * 4. A scenario that fails is a bug of the host, unless users are told about the
 *    difference. Such a difference is a `Deliberate` entry in `differences.ts`,
 *    with the exact behaviour of the host and the sentence of the documentation
 *    that promises it. The suite fails when the host does something else, when
 *    it no longer differs, and when the sentence is gone. A difference that
 *    nobody documented, or a bug that is not fixed yet, is an `Open` entry with
 *    its evidence, and is reported.
 *
 * The reference is `LocalMachine` with its generic strategy, which has no
 * deliberate difference. Scenarios say what it does, except where it is an open
 * entry itself.
 */
import { Cause, Effect, type Scope } from "effect"
import { Machine } from "../../../src/index.js"
import type { Fixture } from "./fixture.js"

/** Kinds of work a state can invoke. */
export type InvocationKind = "Effect" | "Timer" | "Stream" | "Logic" | "Child"

/** What a host declares about itself, as data. */
export interface Capabilities {
  /**
   * Kinds of work the host runs. A host that runs timers waits on the `Clock` of
   * the fiber that starts the instance, which is a `TestClock`.
   */
  readonly invocations: ReadonlyArray<InvocationKind>

  /** Whether running work can spawn, address, and stop children of its machine. */
  readonly ownedChildren: boolean

  /** Whether the host executes the commands of a transition, `enqueue.sendTo` and `enqueue.stop`. */
  readonly commands: boolean

  /** Whether the host can bring a machine back from what it made durable. */
  readonly restart: boolean

  /** Whether the owner of a machine can stop it. */
  readonly stop: boolean

  /** Whether the events a machine emits can be observed. */
  readonly emissions: boolean

  /**
   * Whether the host can refuse one event and keep the machine. A host that
   * cannot either takes an event or no longer runs the machine, and the suite
   * rejects any other answer from it.
   */
  readonly rejection: boolean

  /**
   * When a new machine settles in its initial state. A host that plans it
   * together with the first event publishes nothing before that event, and need
   * not publish the initial state at all.
   */
  readonly initialState: "AtStart" | "WithFirstEvent"
}

/** How a host answered an event. */
export type Answer =
  /** The host took the event. */
  | "Accepted"
  /** The machine is final, failed, or stopped, and takes no more events. */
  | "Ended"
  /** The host refused this event, and the machine goes on as if it never came. */
  | "Rejected"

/** Where a machine stands. */
export type Outcome =
  | { readonly _tag: "Running" }
  | { readonly _tag: "Final"; readonly output?: unknown }
  /** `failure` is a rendering by {@link renderFailure}, or one that equals it. */
  | { readonly _tag: "Failed"; readonly failure: string }
  | { readonly _tag: "Stopped" }

/** Everything a host needs to start one machine. */
export interface StartOptions {
  readonly machine: Machine.Machine.Any

  /** The decoded input of the machine, for one that declares it. */
  readonly input: ReadonlyArray<unknown>
}

/**
 * One machine that a host runs.
 *
 * `states` and `emitted` grow while the machine runs. The suite reads them when
 * nothing that does not wait for time is left to happen.
 */
export interface Instance {
  /** Sends a public event, and returns how the host answered. Never fails. */
  readonly send: (event: object) => Effect.Effect<Answer>

  /**
   * The settled states the host published or made durable, in order. A state may
   * repeat, and no state a machine only passed through may appear.
   */
  readonly states: ReadonlyArray<Machine.Machine.EncodedSnapshot>

  /**
   * The state that holds at this moment, read while the host runs the machine.
   * `undefined` before there is one. The suite calls it when work starts, to see
   * that the state which owns the work came first.
   */
  readonly current: () => Machine.Machine.EncodedSnapshot | undefined

  /** The events the machine emitted, in order. Empty without the capability. */
  readonly emitted: ReadonlyArray<unknown>

  readonly outcome: Effect.Effect<Outcome>

  /** Stops the machine as its owner would. Only with the capability. */
  readonly stop: Effect.Effect<void>

  /**
   * Takes the host down, lets exactly `downtime` pass, and brings the machine
   * back from what the host made durable. `downtime` is at least two seconds.
   * Only with the capability.
   */
  readonly restart: (downtimeMillis: number) => Effect.Effect<void>
}

/** A host of the suite. */
export interface Host {
  readonly name: string
  readonly capabilities: Capabilities

  /**
   * Starts one machine, owned by the scope. A machine that cannot start is an
   * instance whose outcome is `Failed`.
   */
  readonly start: (options: StartOptions) => Effect.Effect<Instance, never, Scope.Scope>
}

/** A member that a host without the capability does not implement. */
export const unsupported = (capability: string): Effect.Effect<never> =>
  Effect.die(new Error(`This host declares that it does not support ${capability}`))

const renderValue = (value: unknown): string => {
  if (!(value instanceof Error)) return typeof value === "string" ? value : JSON.stringify(value)
  // A tagged error without a message describes itself with its fields.
  const fields = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "_tag" && key !== "cause"))
  return `${value.name}: ${value.message === "" ? JSON.stringify(fields) : value.message}`
}

/** Renders why a machine failed, without stack traces. */
export const renderFailure = (cause: Cause.Cause<unknown>): string =>
  cause.reasons.map((reason) =>
    Cause.isFailReason(reason)
      ? renderValue(reason.error)
      : Cause.isDieReason(reason)
      ? renderValue(reason.defect)
      : "Interrupted"
  ).join("\n")

/** Encodes a decoded snapshot the way every host reports it. */
export const encode = (
  machine: Machine.Machine.Any,
  snapshot: unknown
): Machine.Machine.EncodedSnapshot =>
  Effect.runSync(
    Machine.encodeSnapshot(machine as never, snapshot as never) as Effect.Effect<Machine.Machine.EncodedSnapshot>
  )

/** Decodes what {@link encode} returned, for a host that restarts. */
export const decode = (
  machine: Machine.Machine.Any,
  snapshot: Machine.Machine.EncodedSnapshot
): Machine.Machine.Snapshot<any> =>
  Effect.runSync(
    Machine.decodeSnapshot(machine as never, JSON.parse(JSON.stringify(snapshot))) as Effect.Effect<any>
  )

/** A machine whose work and records belong to one run of a scenario. */
export type MakeMachine = (fixture: Fixture) => Machine.Machine.Any
