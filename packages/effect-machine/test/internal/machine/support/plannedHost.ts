import { Effect } from "effect"
import type { Machine } from "../../../../src/index.js"
import * as Configuration from "../../../../src/internal/machine/configuration.js"
import * as InvocationChanges from "../../../../src/internal/machine/invocationChanges.js"
import type * as InvocationEvent from "../../../../src/internal/machine/invocationEvent.js"
import { InvocationGenerations } from "../../../../src/internal/machine/invocationGeneration.js"
import * as InvocationOutcome from "../../../../src/internal/machine/invocationOutcome.js"
import * as InvocationResolution from "../../../../src/internal/machine/invocationResolution.js"
import * as Planner from "../../../../src/internal/machine/planner.js"

/** One invocation a host has to run, with the generation of its group. */
export interface Started {
  readonly invocation: InvocationResolution.ResolvedInvocation
  readonly generation: InvocationEvent.Generation
}

const refused = new Error("This host owns no children")

/**
 * A host without a runtime. It plans events, keeps generations, and lists the
 * invocations to run, which each test runs and settles in its own order.
 */
export class PlannedHost {
  readonly generations = new InvocationGenerations()
  readonly sent: Array<unknown> = []

  /** What an event sent to the machine itself does. */
  deliver: (event: unknown) => Effect.Effect<void> = (event) => Effect.sync(() => void this.sent.push(event))

  /** The output of the machine, once it is final. */
  ending: { readonly output: unknown } | undefined
  private readonly emitted: Array<unknown> = []

  readonly self: Machine.MachineTarget<any>
  readonly children: Machine.ChildOwner<any> = {
    spawn: () => Effect.die(refused),
    sendTo: () => Effect.die(refused),
    stop: () => Effect.die(refused)
  }
  readonly started: ReadonlyArray<Started>
  private configuration: Configuration.ActiveConfiguration

  constructor(private readonly machine: Machine.Machine.Any, ...input: ReadonlyArray<unknown>) {
    const id = machine.id ?? "planned-host"
    this.self = { id, sessionId: `${id}:1`, send: (event) => Effect.suspend(() => this.deliver(event)) }
    const planned = Planner.planInitialSync(machine, ...input)
    this.configuration = Configuration.normalizeConfigurationSync(machine, planned.state)
    this.emitted.push(...planned.emittedEvents)
    if (planned.done) this.ending = { output: planned.output }
    this.started = planned.done ? [] : this.start(
      Configuration.getInitialEntryPaths(machine, this.configuration),
      Planner.InitialEvent
    )
  }

  /** The logical state, as hosts publish and store it. */
  get snapshot(): Machine.Machine.Snapshot<any> {
    return Configuration.snapshotFromConfiguration(this.machine, this.configuration)
  }

  /** Takes the events emitted since they were last taken. */
  takeEmitted(): ReadonlyArray<unknown> {
    return this.emitted.splice(0)
  }

  get leaves(): ReadonlyArray<string> {
    return Configuration.getActiveLeafPaths(this.machine, this.configuration)
  }

  value(path: string): unknown {
    return this.configuration.values.get(path)
  }

  resolve(
    paths: ReadonlyArray<string>,
    event: Machine.Machine.LifecycleEvent<any>
  ): ReadonlyArray<InvocationResolution.InvocationGroup> {
    return InvocationResolution.resolve(this.machine, this.configuration, paths, event, {
      self: this.self,
      parent: undefined,
      children: this.children
    })
  }

  private start(
    paths: ReadonlyArray<string>,
    event: Machine.Machine.LifecycleEvent<any>
  ): ReadonlyArray<Started> {
    return this.resolve(paths, event).flatMap((group) => {
      const generation = this.generations.beginGeneration(group.path)
      return group.invocations.map((invocation) => ({ invocation, generation }))
    })
  }

  /** Plans one event and returns the invocations it starts. */
  send(event: object): ReadonlyArray<Started> {
    const planned = Planner.planConfiguration(this.machine, this.configuration, event)
    this.configuration = planned.next
    this.emitted.push(...planned.emittedEvents)
    const changes = InvocationChanges.fromMicrosteps(planned.microsteps)
    this.generations.retireGenerations(changes?.exited ?? [])
    if (planned.done) {
      this.ending = { output: planned.output }
      this.generations.retireAllGenerations()
      return []
    }
    return Array.from(changes?.entered ?? []).flatMap(([path, event]) => this.start([path], event))
  }

  /** Performs a decision and returns the invocations it starts. */
  perform(decision: InvocationOutcome.Decision): ReadonlyArray<Started> {
    switch (decision._tag) {
      case "Deliver":
        return this.send(decision.event)
      case "Fail":
        throw new Error("The host failed its machine", { cause: decision.cause })
      case "Ignore":
        return []
    }
  }
}

export const decide = (started: Started, outcome: InvocationOutcome.Outcome): InvocationOutcome.Decision =>
  InvocationOutcome.decide(started.invocation, started.generation, outcome)
