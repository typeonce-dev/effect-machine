import { Machine } from "@typeonce/effect-machine"

// A member of the `Machine.Machine` namespace is public only when it is
// written with `export`. The others are private implementation details:
// naming one from outside the package must fail on every supported compiler.

const Root = Machine.state({ states: { Idle: {}, Done: {} } })
type Schemas = { readonly "": typeof Root.node }

export type Documented = [
  Machine.Machine.Any,
  Machine.Machine.CompoundSnapshot<"", undefined, Machine.Machine.AtomicSnapshot<"Idle", undefined>>,
  Machine.Machine.EventProtocol.Any,
  Machine.Machine.HistoryDefaultEntry<Schemas, readonly [], readonly [], "Idle">
]

// @ts-expect-error Handler evidence is private to `.handle`.
export type HandlerTreeEvidence = Machine.Machine.HandlerTreeEvidence<Schemas, {}>
// @ts-expect-error Configuration normalization is private to `.handle`.
export type NormalizeObjectConfig = Machine.Machine.NormalizeObjectConfig<{}, {}>
// @ts-expect-error Resolved invocation sources are private to `.handle`.
export type ResolvedInvoke = Machine.Machine.ResolvedInvoke<{}, "load">
// @ts-expect-error Handler error inference is private to `.handle`.
export type HandlerConfigError = Machine.Machine.HandlerConfigError<{}>
// @ts-expect-error Compile-error messages are private to `.handle`.
export type StateFieldError = Machine.Machine.StateFieldError<"Atomic", "Idle", "states", "Remove it.">
