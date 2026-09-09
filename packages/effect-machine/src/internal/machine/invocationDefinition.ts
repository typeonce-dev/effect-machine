import type * as Duration from "effect/Duration"
import type * as Effect from "effect/Effect"
import type * as Stream from "effect/Stream"
import type { ChildMachine, Logic, Machine } from "../../Machine.js"
import type { EventTransition } from "./transition.js"

// Source callbacks cross the erased machine-definition boundary here. Their
// state, event, error and service relationships are checked by the public builder.
type Context = Omit<Machine.InvokeContext<any, any, any, any>, "root">
interface Outcomes {
  readonly onDone?: EventTransition<any, any, any, any>
  readonly onFailure?: EventTransition<any, any, any, any>
  readonly onElement?: EventTransition<any, any, any, any>
  readonly onSnapshot?: EventTransition<any, any, any, any>
}

export type InvocationDefinition =
  & Outcomes
  & (
    | { readonly id: string; readonly effect: (context: Context) => Effect.Effect<unknown, unknown, unknown> }
    | { readonly id: string; readonly stream: (context: Context) => Stream.Stream<unknown, unknown, unknown> }
    | { readonly id: string; readonly after: Duration.Input | ((context: Context) => Duration.Input) }
    | {
      readonly id: string
      readonly address: string
      readonly logic: Logic<any, any, any, any, any> | ((context: Context) => Logic<any, any, any, any, any>)
    }
    | { readonly child: ChildMachine.Any; readonly input?: unknown }
  )

/** Captures exactly one invocation source before any planner or runtime sees it. */
export const capture = (config: Record<PropertyKey, unknown>, path: string): InvocationDefinition => {
  const sources = ["effect", "stream", "after", "logic", "child"].filter((key) => key in config)
  if (sources.length !== 1) {
    throw new Error(`Machine invocation for state "${path}" must define exactly one source`)
  }
  if (sources[0] !== "child" && typeof config.id !== "string") {
    throw new Error(`Machine invocation for state "${path}" requires a string id`)
  }
  if ((sources[0] === "effect" || sources[0] === "stream") && typeof config[sources[0]] !== "function") {
    throw new Error(`Machine invocation for state "${path}" requires a source callback`)
  }
  return Object.freeze(config) as unknown as InvocationDefinition
}

/** Only captured state handlers cross this erased boundary. */
export const definitions = (invoke: unknown): ReadonlyArray<InvocationDefinition> =>
  invoke === undefined
    ? []
    : Array.isArray(invoke)
    ? invoke as ReadonlyArray<InvocationDefinition>
    : [invoke as InvocationDefinition]
