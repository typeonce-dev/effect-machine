/** Captures reusable sources and topology declarations before handler compilation. */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type { Machine } from "../../Machine.js"
import * as Topology from "./topology.js"

type SourceKind = "effects" | "streams" | "timers" | "logic" | "children"
interface Source {
  readonly kind: SourceKind
  readonly value: unknown
}
type PathKind = "state" | "choice" | "history"
export interface Declaration {
  readonly initialize?: (input: unknown) => unknown
  readonly root: Machine.Any["root"]
  /** Whether the machine declares an input schema used by `initialize`. */
  readonly input: boolean
  /** Declared state paths keyed by internal identifier; the root is `""`. */
  readonly paths: ReadonlyMap<string, PathKind>
  readonly sources: ReadonlyMap<string, Source>
}
const record = (value: unknown, message: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}
/** The root node's public path name. Top-level states cannot use it. */
export const rootPathName = "root"
const collectPaths = (root: Machine.Any["root"]): ReadonlyMap<string, PathKind> => {
  const paths = new Map<string, PathKind>()
  const visit = (node: Machine.StateNodeConfig | Machine.TaggedSchema, path: string): void => {
    const type = !Schema.isSchema(node) && "type" in node ? node.type : undefined
    paths.set(path, type === "history" || type === "choice" ? type : "state")
    if (!Schema.isSchema(node) && "states" in node) {
      for (const [key, child] of Object.entries(node.states)) visit(child, path === "" ? key : `${path}.${key}`)
    }
  }
  visit(root.node, "")
  if (paths.has(rootPathName)) {
    throw new Error(`Machine top-level state name "${rootPathName}" is reserved for the root`)
  }
  return paths
}
export const capture = (
  root: Machine.Any["root"],
  config: Readonly<Record<string, unknown>>
): Declaration => {
  const paths = collectPaths(root)
  const input = config.input !== undefined
  const sources = new Map<string, Source>()
  for (const kind of ["effects", "streams", "timers", "logic", "children"] as const) {
    if (config[kind] === undefined) continue
    for (const [name, value] of Object.entries(record(config[kind], `Machine ${kind} must be a source map`))) {
      if (sources.has(name)) throw new Error(`Machine source name "${name}" is registered more than once`)
      sources.set(name, Object.freeze({ kind, value }))
    }
  }
  return { root, input, paths, sources }
}
const reference = (
  value: unknown,
  declaration: Declaration
): { readonly path: string; readonly kind: PathKind } => {
  const path = value === rootPathName ? "" : typeof value === "string" && value !== "" ? value : undefined
  const kind = path === undefined ? undefined : declaration.paths.get(path)
  if (path === undefined || kind === undefined) {
    throw new Error(`Machine target ${String(value)} is not a declared state path`)
  }
  return { path, kind }
}
/** The single owner named by a transition's `update` record. */
export const updateOwner = (update: unknown): string => {
  const keys = record(update, "Machine update must be a record with one owner")
  const owners = Object.keys(keys)
  if (owners.length !== 1 || Object.getOwnPropertySymbols(keys).length > 0) {
    throw new Error(`Machine update takes one owner, got: ${owners.join(", ")}`)
  }
  return owners[0]!
}
export const selection = (
  declaration: Declaration,
  config: Readonly<Record<string, unknown>>
): Topology.TargetSelection => {
  const keys = ["target", "history", "stay", "initialize"].filter((key) => config[key] !== undefined)
  const owner = typeof config.update === "string" || config.update === undefined
    ? config.update
    : updateOwner(config.update)
  if (keys.length === 0 && owner !== undefined) {
    const reference_ = reference(owner, declaration)
    if (reference_.kind !== "state") throw new Error("Machine update requires an active state reference")
    return Topology.makeTargetSelection("update", reference_.path, "branch")
  }
  if (keys.length === 0 && config.reenter === true) return Topology.noneTargetSelection
  if (keys.length !== 1) throw new Error("Machine transition must declare exactly one destination operation")
  const key = keys[0]!
  if (key === "stay") {
    if (config.stay !== true || owner !== undefined) throw new Error("Machine stay requires stay: true alone")
    if (config.reenter !== undefined) throw new Error("Machine stay cannot reenter; use reenter: true alone")
    return Topology.noneTargetSelection
  }
  if (key === "initialize") {
    if (owner !== undefined) throw new Error("Machine initialize cannot update a retained owner")
    return Topology.makeTargetSelection("state", "", "branch")
  }
  const ref = reference(config[key], declaration)
  if (key === "target" && ref.path === "") {
    throw new Error("Machine root is not a destination; use initialize to reconstruct it from machine input")
  }
  if ((key === "history") !== (ref.kind === "history")) {
    throw new Error("Machine history references require a history transition")
  }
  const update = owner === undefined ? undefined : reference(owner, declaration).path
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
    throw new Error(`Machine invocation "${String(src)}" requires input exactly when its source takes an argument`)
  }
  const resolve = parameterized
    ? (context: unknown) =>
      (source.value as (input: unknown) => unknown)((input as (context: unknown) => unknown)(context))
    : () => source.value
  const field = { effects: "effect", streams: "stream", timers: "after", logic: "logic" }[source.kind]
  return {
    ...rest,
    sourceName: src,
    id: rest.id ?? src,
    [field]: !parameterized && (source.kind === "timers" || source.kind === "logic") ? source.value : resolve
  }
}
