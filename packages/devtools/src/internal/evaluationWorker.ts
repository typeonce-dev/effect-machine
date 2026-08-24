import * as NodeWorkerRunner from "@effect/platform-node/NodeWorkerRunner"
import type { Machine } from "@typeonce/effect-machine"
import * as Effect from "effect/Effect"
import * as WorkerRunner from "effect/unstable/workers/WorkerRunner"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { ViteDevServer } from "vite"
import * as DevToolsProtocol from "../DevToolsProtocol.js"
import * as MachineDocument from "../MachineDocument.js"
import type * as ProjectInspector from "../ProjectInspector.js"

interface EvaluationRequest {
  readonly root: string
  readonly revision: number
  readonly candidates: ReadonlyArray<ProjectInspector.Candidate>
}

interface EvaluationResponse {
  readonly results: ReadonlyArray<DevToolsProtocol.MachineResult>
}

const isMachine = (value: unknown): value is Machine.Machine.Any =>
  typeof value === "object" &&
  value !== null &&
  "stateNodes" in value &&
  "handlers" in value &&
  "initialDefinition" in value &&
  "initial" in value

const sourceOf = (file: string, exportName: string | null): MachineDocument.Source => ({ file, exportName })

const diagnostic = (
  file: string,
  code: string,
  message: string
): DevToolsProtocol.Diagnostic => ({
  severity: "error",
  code,
  message,
  location: { file, line: null, column: null },
  statePath: null
})

const messageOf = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)

const failed = (
  candidate: ProjectInspector.Candidate,
  code: string,
  message: string,
  exportName: string | null = candidate.exportNames[0] ?? null
): DevToolsProtocol.Failed => ({
  _tag: "Failed",
  protocolVersion: DevToolsProtocol.protocolVersion,
  key: exportName === null ? candidate.file : `${candidate.file}#${exportName}`,
  source: sourceOf(candidate.file, exportName),
  machineId: null,
  diagnostics: [diagnostic(candidate.file, code, message)]
})

const evaluateCandidate = (
  server: ViteDevServer,
  request: EvaluationRequest,
  candidate: ProjectInspector.Candidate
): Effect.Effect<ReadonlyArray<DevToolsProtocol.MachineResult>> =>
  Effect.tryPromise({
    try: () => server.ssrLoadModule(pathToFileURL(resolve(request.root, candidate.file)).href),
    catch: (cause) => cause
  }).pipe(
    Effect.flatMap((module) =>
      Effect.try(() =>
        Object.entries(module).filter((entry): entry is [string, Machine.Machine.Any] => isMachine(entry[1]))
      )
    ),
    Effect.flatMap((machines) => {
      if (machines.length === 0) {
        return Effect.succeed([failed(
          candidate,
          "machine-export-not-found",
          "The module contains a .handle(...) call but does not export the resulting machine"
        )])
      }

      const seen = new Set<Machine.Machine.Any>()
      return Effect.forEach(machines, ([exportName, machine]) => {
        if (seen.has(machine)) return Effect.succeed<DevToolsProtocol.MachineResult | undefined>(undefined)
        seen.add(machine)
        const source = sourceOf(candidate.file, exportName)
        return Effect.try({
          try: () =>
            ({
              _tag: "Ready",
              protocolVersion: DevToolsProtocol.protocolVersion,
              key: `${candidate.file}#${exportName}`,
              document: MachineDocument.make(machine, {
                revision: request.revision,
                source
              }),
              diagnostics: []
            }) satisfies DevToolsProtocol.Ready,
          catch: (cause) => cause
        }).pipe(
          Effect.catch((cause) =>
            Effect.succeed(failed(
              candidate,
              "machine-inspection-failed",
              messageOf(cause),
              exportName
            ))
          )
        )
      }).pipe(
        Effect.map((results) =>
          results.filter((result): result is DevToolsProtocol.MachineResult => result !== undefined)
        )
      )
    }),
    Effect.catch((cause) => Effect.succeed([failed(candidate, "module-load-failed", messageOf(cause))]))
  )

const handle = (server: ViteDevServer, request: EvaluationRequest): Effect.Effect<EvaluationResponse> =>
  Effect.forEach(request.candidates, (candidate) => evaluateCandidate(server, request, candidate), {
    concurrency: 1
  }).pipe(
    Effect.map((results) => ({ results: results.flat() }))
  )

export const run = (server: ViteDevServer): Promise<void> => {
  return Effect.gen(function*() {
    const platform = yield* WorkerRunner.WorkerRunnerPlatform
    const runner = yield* platform.start<EvaluationResponse, EvaluationRequest>()
    yield* runner.run((_portId, request) =>
      Effect.flatMap(handle(server, request), (response) => runner.send(0, response))
    )
  }).pipe(
    Effect.provide(NodeWorkerRunner.layer),
    Effect.runPromise
  )
}
