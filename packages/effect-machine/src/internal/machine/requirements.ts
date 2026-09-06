import type { Runtime } from "../../Machine.js"

export type IsAny<A> = 0 extends (1 & A) ? true : false

export type ExcludeCompatibleRuntime<Requirements, Events, Emits> = Requirements extends Runtime.Requirement<
  infer RequiredEvents,
  infer RequiredEmits
> ? IsAny<Requirements> extends true ? Requirements
  : [RequiredEvents] extends [Events] ? [RequiredEmits] extends [Emits] ? never : Requirements
  : Requirements
  : Requirements
