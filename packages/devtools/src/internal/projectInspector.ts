import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as NodeWorker from "@effect/platform-node/NodeWorker"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as Worker from "effect/unstable/workers/Worker"
import { Worker as NodeWorkerThread } from "node:worker_threads"
import ts from "typescript"
import * as DevToolsProtocol from "../DevToolsProtocol.js"
import type * as ProjectInspector from "../ProjectInspector.js"

const defaultInclude = "**/src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"

const defaultExclude = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.data/**",
  "**/references/**",
  "**/*.d.ts"
] as const

interface EvaluationRequest {
  readonly _tag: "InspectMachines"
  readonly root: string
  readonly revision: number
  readonly candidates: ReadonlyArray<ProjectInspector.Candidate>
}

interface EvaluationResponse {
  readonly _tag: "InspectedMachines"
  readonly results: ReadonlyArray<unknown>
}

interface SimulationWorkerRequest {
  readonly _tag: "Simulate"
  readonly root: string
  readonly request: DevToolsProtocol.SimulationRequest
}

type WorkerRequest = EvaluationRequest | SimulationWorkerRequest
type WorkerResponse = EvaluationResponse | DevToolsProtocol.SimulationResult

const scriptKind = (file: string): ts.ScriptKind => {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX
  if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

const hasExportModifier = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) &&
  ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true

const containsHandleCall = (node: ts.Node): boolean => {
  let found = false
  const visit = (current: ts.Node): void => {
    if (found) return
    if (
      ts.isCallExpression(current) &&
      ((ts.isPropertyAccessExpression(current.expression) && current.expression.name.text === "handle") ||
        (ts.isElementAccessExpression(current.expression) &&
          ts.isStringLiteral(current.expression.argumentExpression) &&
          current.expression.argumentExpression.text === "handle"))
    ) {
      found = true
      return
    }
    ts.forEachChild(current, visit)
  }
  visit(node)
  return found
}

export const parseCandidate = (file: string, source: string): ProjectInspector.Candidate | undefined => {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file))
  if (!containsHandleCall(sourceFile)) return undefined

  const exportNames = new Set<string>()
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement) && containsHandleCall(statement.expression)) {
      exportNames.add("default")
      continue
    }
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) && declaration.initializer && containsHandleCall(declaration.initializer)
        ) {
          exportNames.add(declaration.name.text)
        }
      }
    }
  }

  return {
    file,
    exportNames: [...exportNames].sort()
  }
}

const hasSyntacticErrors = (file: string, source: string): boolean =>
  ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: {
      allowJs: true,
      jsx: ts.JsxEmit.Preserve,
      target: ts.ScriptTarget.Latest
    }
  }).diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) === true

interface PublicApi {
  readonly ProjectInspector: typeof ProjectInspector.ProjectInspector
  readonly DiscoveryError: typeof ProjectInspector.DiscoveryError
  readonly EvaluationError: typeof ProjectInspector.EvaluationError
}

const makeDiscovery = (api: PublicApi) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    return (options: ProjectInspector.InspectOptions): Effect.Effect<
      ReadonlyArray<ProjectInspector.Candidate>,
      ProjectInspector.DiscoveryError
    > =>
      Effect.gen(function*() {
        const root = path.resolve(options.root)
        const retainedByFile = new Map(
          (options.retainedCandidates ?? []).map((candidate) => [candidate.file, candidate])
        )
        const files = yield* fs.glob(options.include ?? defaultInclude, {
          root,
          exclude: [...defaultExclude, ...(options.exclude ?? [])]
        })
        const candidates = yield* Effect.forEach(
          files.sort(),
          (file) =>
            fs.readFileString(path.join(root, file)).pipe(
              Effect.map((source) => {
                const candidate = parseCandidate(file, source)
                if (candidate !== undefined) return candidate
                const retained = retainedByFile.get(file)
                return retained !== undefined && hasSyntacticErrors(file, source) ? retained : undefined
              })
            ),
          { concurrency: "unbounded" }
        )
        return candidates.filter((candidate): candidate is ProjectInspector.Candidate => candidate !== undefined)
      }).pipe(
        Effect.mapError((cause) =>
          new api.DiscoveryError({
            message: `Could not discover Effect Machine definitions under ${options.root}`,
            cause
          })
        )
      )
  })

const workerBootstrap = new URL("./evaluationWorkerBootstrap.js", import.meta.url)
const workerRuntime = new URL(
  import.meta.url.endsWith(".ts") ? "./evaluationWorker.ts" : "./evaluationWorker.js",
  import.meta.url
)

const WorkerLayer = NodeWorker.layer(() =>
  new NodeWorkerThread(workerBootstrap, {
    execArgv: [],
    workerData: {
      runtimeModuleUrl: workerRuntime.href
    }
  })
)

const runWorker = (
  request: WorkerRequest
): Effect.Effect<WorkerResponse, unknown> =>
  Effect.scoped(
    Effect.gen(function*() {
      const platform = yield* Worker.WorkerPlatform
      const worker = yield* platform.spawn<WorkerResponse, WorkerRequest>(0)
      const response = yield* Deferred.make<WorkerResponse>()
      const runner = yield* Effect.forkScoped(
        worker.run((message) => Deferred.succeed(response, message))
      )
      yield* worker.send(request)
      return yield* Effect.raceFirst(Deferred.await(response), Fiber.join(runner))
    })
  ).pipe(Effect.provide(WorkerLayer))

const evaluate = (
  api: PublicApi,
  candidates: ReadonlyArray<ProjectInspector.Candidate>,
  options: ProjectInspector.InspectOptions
): Effect.Effect<ReadonlyArray<DevToolsProtocol.MachineResult>, ProjectInspector.EvaluationError> => {
  if (candidates.length === 0) return Effect.succeed([])

  const request: EvaluationRequest = {
    _tag: "InspectMachines",
    root: options.root,
    revision: options.revision ?? 0,
    candidates
  }

  return runWorker(request).pipe(
    Effect.flatMap((message) => {
      if (message._tag !== "InspectedMachines") {
        return Effect.fail(new Error(`Unexpected worker response: ${message._tag}`))
      }
      return Effect.forEach(
        message.results,
        (result) => Schema.decodeUnknownEffect(DevToolsProtocol.MachineResult)(result)
      )
    }),
    Effect.mapError((cause) =>
      new api.EvaluationError({
        message: "The isolated machine evaluator failed",
        cause
      })
    )
  )
}

const simulate = (
  api: PublicApi,
  request: DevToolsProtocol.SimulationRequest,
  options: Pick<ProjectInspector.InspectOptions, "root">
): Effect.Effect<DevToolsProtocol.SimulationResult, ProjectInspector.EvaluationError> =>
  runWorker({ _tag: "Simulate", root: options.root, request }).pipe(
    Effect.timeout("10 seconds"),
    Effect.flatMap((response) => {
      if (response._tag === "InspectedMachines") {
        return Effect.fail(new Error("The isolated planner returned an inspection response"))
      }
      return Schema.decodeUnknownEffect(DevToolsProtocol.SimulationResult)(response)
    }),
    Effect.mapError((cause) =>
      new api.EvaluationError({
        message: "The isolated machine planner failed",
        cause
      })
    )
  )

const make = (api: PublicApi) =>
  Effect.gen(function*() {
    const discover = yield* makeDiscovery(api)
    const inspect = (options: ProjectInspector.InspectOptions) =>
      Effect.flatMap(discover(options), (candidates) => evaluate(api, candidates, options))
    return api.ProjectInspector.of({
      discover,
      evaluate: (candidates, options) => evaluate(api, candidates, options),
      inspect,
      simulate: (request, options) => simulate(api, request, options)
    })
  })

const PlatformLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer)

export const layer = (api: PublicApi): Layer.Layer<ProjectInspector.ProjectInspector> =>
  Layer.effect(api.ProjectInspector, make(api)).pipe(Layer.provide(PlatformLayer))
