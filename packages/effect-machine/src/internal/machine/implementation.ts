import type { Enqueue, Machine } from "../../Machine.js"
import type { InvocationDefinition } from "./invocationDefinition.js"
import type { EventTransition } from "./transition.js"

// Callback contexts are erased after the public builder checks their dependent
// state/event types. Stored transitions are evaluated callbacks, not the public
// selector factories accepted by Definition.handle.
type Transition = EventTransition<any, any, any, any>
type Action = (context: any, enqueue: Enqueue<any, any>) => undefined

export interface CapturedStateConfig {
  readonly entry?: Action
  readonly exit?: Action
  readonly on?: Readonly<Record<PropertyKey, Transition>>
  readonly always?: Transition
  readonly onDone?: Transition
  readonly choice?: Exclude<Transition, (...args: never[]) => unknown>
  readonly invoke?: InvocationDefinition | ReadonlyArray<InvocationDefinition>
  readonly initialize?: (context: any) => unknown
  readonly output?: (context: any) => unknown
  readonly history?: Readonly<
    Record<string, {
      readonly default: (context: any, enqueue: Enqueue<any, any>) => Machine.HandlerResult<any, any, any>
    }>
  >
}

/**
 * Captured machine implementation consumed by semantic layers.
 *
 * Internal code enters through this view so handler lookup cannot silently
 * produce `any`.
 * Construction captures these containers before handing the machine to a planner.
 */
export interface MachineInternal extends Machine.Any {
  readonly handlers: Readonly<Record<string, CapturedStateConfig | undefined>>
}

/** The single conversion from an erased public machine to its captured implementation. */
export const toImpl = (machine: Machine.Any): MachineInternal => machine as MachineInternal
