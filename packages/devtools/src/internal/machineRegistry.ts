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
  const validPrevious = previous.filter((result): result is DevToolsProtocol.Ready | DevToolsProtocol.Partial =>
    result._tag === "Ready" || result._tag === "Partial"
  )
  const previousByKey = new Map(validPrevious.map((result) => [result.key, result]))
  const previousByFile = new Map<string, Array<DevToolsProtocol.Ready | DevToolsProtocol.Partial>>()
  for (const result of validPrevious) {
    const file = result.document.source?.file
    if (file === undefined) continue
    const matches = previousByFile.get(file)
    if (matches === undefined) previousByFile.set(file, [result])
    else matches.push(result)
  }

  const emitted = new Set(next.filter((result) => result._tag !== "Failed").map((result) => result.key))
  return next.flatMap((result): ReadonlyArray<DevToolsProtocol.MachineResult> => {
    if (result._tag !== "Failed") return [result]

    const moduleFailure = result.diagnostics.some((diagnostic) =>
      diagnostic.code === "module-load-failed" || diagnostic.code === "machine-export-not-found"
    )
    const exact = previousByKey.get(result.key)
    const candidates = moduleFailure || exact === undefined
      ? previousByFile.get(result.source.file) ?? []
      : [exact]
    const retained = candidates.filter((candidate) => !emitted.has(candidate.key))
    if (retained.length === 0) return [result]

    for (const candidate of retained) emitted.add(candidate.key)
    return retained.map((candidate): DevToolsProtocol.Partial => ({
      _tag: "Partial",
      protocolVersion: DevToolsProtocol.protocolVersion,
      key: candidate.key,
      document: candidate.document,
      diagnostics: [staleDiagnostic(result), ...result.diagnostics]
    }))
  })
}

const retainedCandidates = (
  results: ReadonlyArray<DevToolsProtocol.MachineResult>
): ReadonlyArray<ProjectInspector.Candidate> => {
  const exportsByFile = new Map<string, Set<string>>()
  for (const result of results) {
    if (result._tag !== "Ready" && result._tag !== "Partial") continue
    const source = result.document.source
    if (source === null) continue
    const exportNames = exportsByFile.get(source.file) ?? new Set<string>()
    if (source.exportName !== null) exportNames.add(source.exportName)
    exportsByFile.set(source.file, exportNames)
  }
  return [...exportsByFile].map(([file, exportNames]) => ({
    file,
    exportNames: [...exportNames].sort()
  }))
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
        inspector.inspect({
          ...options,
          revision: current.revision + 1,
          retainedCandidates: retainedCandidates(current.results)
        }).pipe(
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
