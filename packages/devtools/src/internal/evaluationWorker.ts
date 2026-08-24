import * as NodeWorkerRunner from "@effect/platform-node/NodeWorkerRunner"
import { Machine } from "@typeonce/effect-machine"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"
import * as WorkerRunner from "effect/unstable/workers/WorkerRunner"
import { isAbsolute, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { ViteDevServer } from "vite"
import * as DevToolsProtocol from "../DevToolsProtocol.js"
import * as MachineDocument from "../MachineDocument.js"
import type * as ProjectInspector from "../ProjectInspector.js"

interface EvaluationRequest {
  readonly _tag: "InspectMachines"
  readonly root: string
  readonly revision: number
  readonly candidates: ReadonlyArray<ProjectInspector.Candidate>
}

interface EvaluationResponse {
  readonly _tag: "InspectedMachines"
  readonly results: ReadonlyArray<DevToolsProtocol.MachineResult>
}

interface SimulationWorkerRequest {
  readonly _tag: "Simulate"
  readonly root: string
  readonly request: DevToolsProtocol.SimulationRequest
}

type WorkerRequest = EvaluationRequest | SimulationWorkerRequest
type WorkerResponse = EvaluationResponse | DevToolsProtocol.SimulationResult

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

const messageOf = (cause: unknown): string => {
  if (Schema.isSchemaError(cause)) return `Invalid machine value: ${cause.message}`
  if (cause instanceof Error && cause.message.length > 0) return cause.message
  if (typeof cause === "object" && cause !== null && "cause" in cause && Schema.isSchemaError(cause.cause)) {
    const boundary = "boundary" in cause ? String(cause.boundary) : "value"
    return `Invalid machine ${boundary}: ${cause.cause.message}`
  }
  try {
    const encoded = JSON.stringify(cause, null, 2)
    if (encoded !== undefined && encoded !== "{}") return encoded
  } catch {
    // Fall back to the runtime string representation below.
  }
  const rendered = String(cause)
  return rendered.length > 0 ? rendered : "The planner failed without a diagnostic message"
}

const jsonValue = (value: unknown): Schema.Json => {
  const seen = new WeakSet<object>()
  const encoded = JSON.stringify(value, (_key, current: unknown) => {
    if (typeof current === "bigint") return `${current}n`
    if (typeof current === "function") return `[Function ${current.name || "anonymous"}]`
    if (typeof current === "symbol") return String(current)
    if (typeof current === "undefined") return null
    if (typeof current === "object" && current !== null) {
      if (seen.has(current)) return "[Circular]"
      seen.add(current)
    }
    return current
  })
  return encoded === undefined ? null : JSON.parse(encoded) as Schema.Json
}

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
    Effect.map((results) => ({ _tag: "InspectedMachines" as const, results: results.flat() }))
  )

interface DynamicMicrostep {
  readonly next: unknown
  readonly event: unknown
  readonly transitions: ReadonlyArray<Machine.Machine.RetainedTransition>
  readonly commands: ReadonlyArray<Machine.Command>
  readonly raisedEvents: ReadonlyArray<unknown>
  readonly emittedEvents: ReadonlyArray<unknown>
  readonly exitPaths: ReadonlyArray<string>
  readonly entryPaths: ReadonlyArray<string>
  readonly changed: boolean
}

interface DynamicPlan {
  readonly startingState?: unknown
  readonly state?: unknown
  readonly next?: unknown
  readonly commands: ReadonlyArray<Machine.Command>
  readonly emittedEvents: ReadonlyArray<unknown>
  readonly microsteps: ReadonlyArray<DynamicMicrostep>
  readonly done: boolean
  readonly output: unknown
}

const planInitial = Machine.planInitial as unknown as (
  machine: Machine.Machine.Any,
  ...input: ReadonlyArray<unknown>
) => Effect.Effect<DynamicPlan, unknown>

const plan = Machine.plan as (
  machine: Machine.Machine.Any,
  snapshot: unknown,
  event: unknown
) => Effect.Effect<DynamicPlan, unknown>

const encodeSnapshot = Machine.encodeSnapshot as (
  machine: Machine.Machine.Any,
  snapshot: unknown
) => Effect.Effect<DevToolsProtocol.EncodedSnapshot, unknown>

const decodeSnapshot = Machine.decodeSnapshot as (
  machine: Machine.Machine.Any,
  snapshot: unknown
) => Effect.Effect<unknown, unknown>

const validateSchemaInput = (
  schema: Schema.Top,
  input: unknown
): Effect.Effect<void, Schema.SchemaError> =>
  schema.makeEffect(input as never, { parseOptions: { errors: "all" } }).pipe(
    Effect.asVoid,
    Effect.mapError((issue) => new Schema.SchemaError(issue))
  )

const isJsonSchemaRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const resolveJsonSchemaReference = (
  value: unknown,
  definitions: Readonly<Record<string, unknown>>
): Record<string, unknown> | undefined => {
  if (!isJsonSchemaRecord(value)) return undefined
  if (typeof value.$ref !== "string" || !value.$ref.startsWith("#/$defs/")) return value
  const target = definitions[decodeURIComponent(value.$ref.slice("#/$defs/".length))]
  return isJsonSchemaRecord(target) ? target : undefined
}

const inputEventTags = (schema: Machine.Machine.TaggedSchema): ReadonlySet<string> => {
  const document = Schema.toJsonSchemaDocument(schema)
  const root = resolveJsonSchemaReference(document.schema, document.definitions) ?? document.schema
  const variants = isJsonSchemaRecord(root) && Array.isArray(root.anyOf)
    ? root.anyOf
    : isJsonSchemaRecord(root) && Array.isArray(root.oneOf)
    ? root.oneOf
    : [root]
  const tags = new Set<string>()
  for (const variant of variants) {
    const resolved = resolveJsonSchemaReference(variant, document.definitions)
    if (resolved === undefined || !isJsonSchemaRecord(resolved.properties)) continue
    const tag = resolveJsonSchemaReference(resolved.properties._tag, document.definitions)
    if (tag === undefined) continue
    if (typeof tag.const === "string" || typeof tag.const === "number") tags.add(String(tag.const))
    if (Array.isArray(tag.enum)) {
      tag.enum.forEach((value) => {
        if (typeof value === "string" || typeof value === "number") tags.add(String(value))
      })
    }
  }
  return tags
}

const inputEventSchemas = Machine.inputEventSchemas as (
  machine: Machine.Machine.Any
) => ReadonlyArray<Machine.Machine.TaggedSchema>

const validateInitialInput = (
  machine: Machine.Machine.Any,
  request: DevToolsProtocol.StartSimulation
): Effect.Effect<void, Schema.SchemaError | Error> => {
  if (machine.input === undefined) {
    return Object.hasOwn(request, "input")
      ? Effect.fail(new Error("This machine does not accept startup input"))
      : Effect.void
  }
  return validateSchemaInput(machine.input, request.input)
}

const validateEventInput = (
  machine: Machine.Machine.Any,
  event: unknown
): Effect.Effect<void, Schema.SchemaError | Error> => {
  if (typeof event !== "object" || event === null || !("_tag" in event)) {
    return Effect.fail(new Error("A public event requires a _tag discriminator"))
  }
  const tag = String(event._tag)
  const schemas = inputEventSchemas(machine)
  const schema = schemas.find((schema) => inputEventTags(schema).has(tag))
  return schema === undefined
    ? Effect.fail(new Error(`This machine does not accept the public event ${tag}`))
    : validateSchemaInput(schema, event)
}

const configuration = Machine.configuration as (
  machine: Machine.Machine.Any,
  snapshot: unknown
) => ReadonlyArray<{ readonly path: string }>

const enabled = Machine.enabled as (
  machine: Machine.Machine.Any,
  snapshot: unknown
) => ReadonlyArray<PropertyKey>

const simulationEvent = (machine: Machine.Machine.Any, value: Schema.Json): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("_tag" in value)) return value
  const tag = value._tag
  if (typeof tag !== "string" && typeof tag !== "number") return value
  if (!Object.hasOwn(machine.events, tag)) return value
  const constructor = Reflect.get(machine.events, tag)
  if (typeof constructor !== "function") return value
  const { _tag: _, ...payload } = value
  return constructor(payload)
}

const simulationSnapshot = (
  machine: Machine.Machine.Any,
  snapshot: unknown
): DevToolsProtocol.SimulationSnapshot => {
  const publicEvents = new Set(Reflect.ownKeys(machine.events).map(String))
  return {
    activePaths: configuration(machine, snapshot).map((node) => node.path),
    candidateEvents: enabled(machine, snapshot).map(String).filter((event) => publicEvents.has(event))
  }
}

const trigger = (value: Machine.Machine.TransitionTrigger): MachineDocument.Trigger => {
  switch (value.type) {
    case "event":
      return { type: "event", event: String(value.event) }
    case "always":
      return { type: "always" }
    case "done":
      return { type: "done" }
    case "choice":
      return { type: "choice" }
    case "invoke":
      return { type: "invoke", id: value.id, outcome: value.outcome }
  }
}

const commandTarget = (target: unknown): string => {
  if (typeof target === "string") return target
  if (typeof target === "object" && target !== null && "id" in target) return String(target.id)
  return String(target)
}

const command = (value: Machine.Command): DevToolsProtocol.PlannedCommand =>
  value._tag === "SendTo"
    ? { _tag: "SendTo", target: commandTarget(value.target), event: jsonValue(value.event) }
    : { _tag: "Stop", target: commandTarget(value.child) }

const microstep = (
  machine: Machine.Machine.Any,
  value: DynamicMicrostep,
  index: number
): DevToolsProtocol.SimulationMicrostep => ({
  index,
  event: jsonValue(value.event),
  transitions: value.transitions.map((transition) => ({
    source: transition.source,
    trigger: trigger(transition.trigger),
    reenter: transition.reenter,
    branchIndex: transition.branchIndex,
    branchKey: transition.branchKey ?? null,
    target: transition.target ?? null,
    resolvedTarget: transition.resolvedTarget ?? null,
    updates: [...transition.updates]
  })),
  commands: value.commands.map(command),
  raisedEvents: value.raisedEvents.map(jsonValue),
  emittedEvents: value.emittedEvents.map(jsonValue),
  exitPaths: [...value.exitPaths],
  entryPaths: [...value.entryPaths],
  activePaths: configuration(machine, value.next).map((node) => node.path),
  changed: value.changed
})

const simulationDiagnostic = (
  request: DevToolsProtocol.SimulationRequest,
  code: string,
  cause: unknown
): DevToolsProtocol.SimulationFailed => ({
  _tag: "SimulationFailed",
  protocolVersion: DevToolsProtocol.protocolVersion,
  key: request.key,
  revision: request.revision,
  inputIssues: inputIssuesOf(cause),
  diagnostics: [diagnostic(request.source.file, code, messageOf(cause))]
})

const inputIssuesOf = (cause: unknown): ReadonlyArray<DevToolsProtocol.InputIssue> => {
  const schemaError = Schema.isSchemaError(cause)
    ? cause
    : typeof cause === "object" && cause !== null && "cause" in cause && Schema.isSchemaError(cause.cause)
    ? cause.cause
    : undefined
  if (schemaError === undefined) return []
  return SchemaIssue.makeFormatterStandardSchemaV1()(schemaError.issue).issues.map((issue) => ({
    path: issue.path?.map((part) => typeof part === "number" ? part : String(part)) ?? [],
    message: issue.message
  }))
}

const isProjectFile = (root: string, file: string): boolean => {
  const absoluteRoot = resolve(root)
  const absoluteFile = resolve(absoluteRoot, file)
  const projectPath = relative(absoluteRoot, absoluteFile)
  return projectPath !== "" && !projectPath.startsWith("..") && !isAbsolute(projectPath)
}

const loadSimulationMachine = (
  server: ViteDevServer,
  workerRequest: SimulationWorkerRequest
): Effect.Effect<Machine.Machine.Any, unknown> => {
  const request = workerRequest.request
  if (!isProjectFile(workerRequest.root, request.source.file)) {
    return Effect.fail(new Error("The requested machine source is outside the project root"))
  }
  if (request.source.exportName === null) {
    return Effect.fail(new Error("The requested machine does not have an exported module binding"))
  }
  return Effect.tryPromise({
    try: () => server.ssrLoadModule(pathToFileURL(resolve(workerRequest.root, request.source.file)).href),
    catch: (cause) => cause
  }).pipe(
    Effect.flatMap((module) => {
      const candidate = module[request.source.exportName!]
      return isMachine(candidate)
        ? Effect.succeed(candidate)
        : Effect.fail(new Error(`Export ${request.source.exportName} is not an Effect Machine`))
    })
  )
}

const makeSimulationReady = (
  request: DevToolsProtocol.SimulationRequest,
  machine: Machine.Machine.Any,
  before: unknown,
  after: unknown,
  planResult: DynamicPlan
): Effect.Effect<DevToolsProtocol.SimulationReady, unknown> =>
  Effect.map(encodeSnapshot(machine, after), (snapshot) => {
    const step = request._tag === "StartSimulation" ? 0 : request.step + 1
    const frame: DevToolsProtocol.SimulationFrame = {
      step,
      trigger: request._tag === "StartSimulation"
        ? {
          _tag: "Initial",
          ...(Object.hasOwn(request, "input") ? { input: request.input } : {})
        }
        : { _tag: "Event", event: request.event },
      before: simulationSnapshot(machine, before),
      after: simulationSnapshot(machine, after),
      microsteps: planResult.microsteps.map((value, index) => microstep(machine, value, index)),
      commands: planResult.commands.map(command),
      emittedEvents: planResult.emittedEvents.map(jsonValue),
      done: planResult.done,
      ...(planResult.done && planResult.output !== undefined ? { output: jsonValue(planResult.output) } : {})
    }
    return {
      _tag: "SimulationReady",
      protocolVersion: DevToolsProtocol.protocolVersion,
      key: request.key,
      revision: request.revision,
      step,
      snapshot,
      current: frame.after,
      frame
    }
  })

const simulate = (
  server: ViteDevServer,
  workerRequest: SimulationWorkerRequest
): Effect.Effect<DevToolsProtocol.SimulationResult> => {
  const request = workerRequest.request
  return loadSimulationMachine(server, workerRequest).pipe(
    Effect.flatMap((machine) => {
      if (request._tag === "StartSimulation") {
        return Effect.flatMap(validateInitialInput(machine, request), () => {
          const planned = Object.hasOwn(request, "input")
            ? planInitial(machine, request.input)
            : planInitial(machine)
          return Effect.flatMap(planned, (result) => {
            const before = result.startingState ?? result.state
            const after = result.state
            if (before === undefined || after === undefined) {
              return Effect.fail(new Error("The initial planner did not return a state snapshot"))
            }
            return makeSimulationReady(request, machine, before, after, result)
          })
        })
      }
      return Effect.flatMap(validateEventInput(machine, request.event), () =>
        Effect.flatMap(
          decodeSnapshot(machine, request.snapshot),
          (before) =>
            Effect.flatMap(plan(machine, before, simulationEvent(machine, request.event)), (result) => {
              if (result.next === undefined) return Effect.fail(new Error("The planner did not return a next snapshot"))
              return makeSimulationReady(request, machine, before, result.next, result)
            })
        ))
    }),
    Effect.catch((cause) => Effect.succeed(simulationDiagnostic(request, "simulation-planning-failed", cause)))
  )
}

export const run = (server: ViteDevServer): Promise<void> => {
  return Effect.gen(function*() {
    const platform = yield* WorkerRunner.WorkerRunnerPlatform
    const runner = yield* platform.start<WorkerResponse, WorkerRequest>()
    yield* runner.run((_portId, request) => {
      const response: Effect.Effect<WorkerResponse> = request._tag === "InspectMachines"
        ? handle(server, request)
        : simulate(server, request)
      return Effect.flatMap(response, (value) => runner.send(0, value))
    })
  }).pipe(
    Effect.provide(NodeWorkerRunner.layer),
    Effect.runPromise
  )
}
