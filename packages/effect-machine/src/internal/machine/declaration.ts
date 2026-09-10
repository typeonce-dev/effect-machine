/** Captures reusable sources and topology declarations before handler compilation. */
import * as Effect from "effect/Effect"
import { hasProperty } from "effect/Predicate"
import * as Stream from "effect/Stream"
import type { Machine, State } from "../../Machine.js"
import * as Reference from "./targetReference.js"
import * as Topology from "./topology.js"

type SourceKind = "effects" | "streams" | "timers" | "logic" | "children"
interface Source {
  readonly kind: SourceKind
  readonly value: unknown
}
export interface Declaration {
  readonly initialize?: (input: unknown) => unknown
  readonly root: State<Machine.StateNodeConfig>
  readonly sources: ReadonlyMap<string, Source>
  readonly branches: ReadonlyMap<string, Readonly<Record<string, Readonly<Record<string, unknown>>>>>
}
const record = (value: unknown, message: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}
export const capture = (
  root: State<Machine.StateNodeConfig>,
  config: Readonly<Record<string, unknown>>
): Declaration => {
  const sources = new Map<string, Source>()
  for (const kind of ["effects", "streams", "timers", "logic", "children"] as const) {
    if (config[kind] === undefined) continue
    for (const [name, value] of Object.entries(record(config[kind], `Machine ${kind} must be a source map`))) {
      if (sources.has(name)) throw new Error(`Machine source name "${name}" is registered more than once`)
      sources.set(name, Object.freeze({ kind, value }))
    }
  }
  const branches = new Map<string, Readonly<Record<string, Readonly<Record<string, unknown>>>>>()
  if (config.branches !== undefined) {
    for (const [name, group] of Object.entries(record(config.branches, "Machine branches must be a map"))) {
      const branchRecord = record(group, `Machine branches "${name}" must be a branch record`)
      for (const key of Reflect.ownKeys(branchRecord)) {
        if (typeof key !== "string") throw new Error("Machine branches cannot use symbol keys")
        if (key.length === 0 || String(Number(key)) === key) {
          throw new Error("Machine branches require non-index string branch keys")
        }
      }
      const entries = Object.entries(branchRecord)
      if (entries.length === 0) throw new Error(`Machine branches "${name}" requires a branch`)
      branches.set(
        name,
        Object.freeze(Object.fromEntries(entries.map(([key, value]) => {
          const spec = { ...record(value, `Machine branch "${name}.${key}" must be a declaration`) }
          for (const field of Reflect.ownKeys(spec)) {
            if (
              typeof field !== "string" || !["target", "update", "history", "none", "title"].includes(field)
            ) {
              throw new Error(`Machine branch "${name}.${key}" contains an unknown declaration field`)
            }
          }
          if (spec.title !== undefined && (typeof spec.title !== "string" || spec.title.length === 0)) {
            throw new Error("Machine branch title must be a non-empty string")
          }
          selection({ root, sources, branches }, spec)
          return [key, Object.freeze(spec)]
        })))
      )
    }
  }
  return { root, sources, branches }
}
const reference = (value: unknown, root: Declaration["root"]): Reference.Reference[typeof Reference.TypeId] => {
  if (!hasProperty(value, Reference.TypeId)) throw new Error("Machine target must be a declared state reference")
  const ref = (value as Reference.Reference)[Reference.TypeId]
  if (ref.root !== root) throw new Error("Machine target reference belongs to a different root descriptor")
  return ref
}
export const selection = (
  declaration: Declaration,
  config: Readonly<Record<string, unknown>>
): Topology.TargetSelection => {
  const keys = ["target", "history", "none"].filter((key) => config[key] !== undefined)
  if (keys.length === 0 && config.update !== undefined) {
    const owner = reference(config.update, declaration.root)
    if (owner.kind !== "state") throw new Error("Machine update requires an active state reference")
    return Topology.makeTargetSelection("update", owner.path, "branch")
  }
  if (keys.length !== 1) throw new Error("Machine transition must declare exactly one destination operation")
  const key = keys[0]!
  if (key === "none") {
    if (config.none !== true || config.update !== undefined) {
      throw new Error("Machine targetless transition requires none: true")
    }
    return Topology.noneTargetSelection
  }
  const ref = reference(config[key], declaration.root)
  if ((key === "history") !== (ref.kind === "history")) {
    throw new Error("Machine history references require a history transition")
  }
  const update = config.update === undefined ? undefined : reference(config.update, declaration.root).path
  if (update !== undefined && key !== "target") throw new Error("Machine owner updates require an ordinary destination")
  return Topology.makeTargetSelection(
    ref.kind,
    ref.path,
    key === "history" ? "full" : "branch",
    update
  )
}
export const invocation = (
  declaration: Declaration,
  value: unknown,
  path: string,
  adaptContext: (context: unknown) => unknown
): Record<string, unknown> => {
  const config = record(value, `Machine invocation for "${path}" must be an object`)
  const source = typeof config.src === "string" ? declaration.sources.get(config.src) : undefined
  if (source === undefined) throw new Error(`Machine invocation for "${path}" names an unknown source`)
  const { src, input: rawInput, ...rest } = config
  const input = typeof rawInput === "function" ? (context: unknown) => rawInput(adaptContext(context)) : rawInput
  if (source.kind === "children") return { ...rest, child: source.value, ...(input === undefined ? {} : { input }) }
  // Service classes are functions at runtime and also lazy Effect values.
  // Recognize Effect/Stream protocols before treating a function as an input adapter.
  const parameterized = typeof source.value === "function" &&
    !(source.kind === "effects" && Effect.isEffect(source.value)) &&
    !(source.kind === "streams" && Stream.isStream(source.value))
  if (parameterized !== (typeof input === "function")) {
    throw new Error(`Machine invocation "${src}" requires input exactly when its source takes an argument`)
  }
  const resolve = parameterized
    ? (context: unknown) =>
      (source.value as (input: unknown) => unknown)((input as (context: unknown) => unknown)(context))
    : () => source.value
  const field = { effects: "effect", streams: "stream", timers: "after", logic: "logic" }[source.kind]
  return {
    ...rest,
    id: rest.id ?? src,
    [field]: !parameterized && (source.kind === "timers" || source.kind === "logic") ? source.value : resolve
  }
}
