import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SubscriptionRef from "effect/SubscriptionRef"
import * as DevToolsProtocol from "../DevToolsProtocol.js"
import type * as MachineRegistry from "../MachineRegistry.js"
import * as ProjectInspector from "../ProjectInspector.js"

interface PublicApi {
  readonly MachineRegistry: typeof MachineRegistry.MachineRegistry
  readonly RegistryError: typeof MachineRegistry.RegistryError
}

const staleDiagnostic = (failed: DevToolsProtocol.Failed): DevToolsProtocol.Diagnostic => ({
  severity: "warning",
  code: "stale-document",
  message: "Showing the last valid machine document while this module is incomplete.",
  location: failed.source === null
    ? null
    : { file: failed.source.file, line: null, column: null },
  statePath: null
})

export const reconcile = (
  previous: ReadonlyArray<DevToolsProtocol.MachineResult>,
  next: ReadonlyArray<DevToolsProtocol.MachineResult>
): ReadonlyArray<DevToolsProtocol.MachineResult> => {
  const previousByKey = new Map(previous.map((result) => [result.key, result]))
  return next.map((result): DevToolsProtocol.MachineResult => {
    if (result._tag !== "Failed") return result
    const prior = previousByKey.get(result.key)
    if (prior?._tag !== "Ready" && prior?._tag !== "Partial") return result
    return {
      _tag: "Partial",
      protocolVersion: DevToolsProtocol.protocolVersion,
      key: result.key,
      document: prior.document,
      diagnostics: [staleDiagnostic(result), ...result.diagnostics]
    }
  })
}

const make = (api: PublicApi, options: MachineRegistry.Options) =>
  Effect.gen(function*() {
    const inspector = yield* ProjectInspector.ProjectInspector
    const state = yield* SubscriptionRef.make<MachineRegistry.Snapshot>({
      protocolVersion: DevToolsProtocol.protocolVersion,
      revision: 0,
      results: []
    })

    const refresh = SubscriptionRef.get(state).pipe(
      Effect.flatMap((current) =>
        inspector.inspect({ ...options, revision: current.revision + 1 }).pipe(
          Effect.map((results): MachineRegistry.Snapshot => ({
            protocolVersion: DevToolsProtocol.protocolVersion,
            revision: current.revision + 1,
            results: reconcile(current.results, results)
          }))
        )
      ),
      Effect.tap((next) => SubscriptionRef.set(state, next)),
      Effect.mapError((cause) =>
        new api.RegistryError({
          message: `Could not inspect Effect Machine definitions under ${options.root}`,
          cause
        })
      )
    )

    yield* refresh

    return api.MachineRegistry.of({
      get: SubscriptionRef.get(state),
      changes: SubscriptionRef.changes(state),
      refresh
    })
  })

export const layer = (
  api: PublicApi,
  options: MachineRegistry.Options
): Layer.Layer<MachineRegistry.MachineRegistry, MachineRegistry.RegistryError, ProjectInspector.ProjectInspector> =>
  Layer.effect(api.MachineRegistry, make(api, options))
