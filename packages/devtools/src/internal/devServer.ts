import { type ChokidarOptions, type FSWatcher, watch } from "chokidar"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type { IncomingMessage, ServerResponse } from "node:http"
import { isAbsolute, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createServer, type Plugin, type ViteDevServer } from "vite"
import type * as DevServer from "../DevServer.js"
import * as DevToolsProtocol from "../DevToolsProtocol.js"
import * as MachineRegistry from "../MachineRegistry.js"
import * as ProjectInspector from "../ProjectInspector.js"

type DevServerErrorConstructor = typeof DevServer.DevServerError

const packageRoot = fileURLToPath(new URL("../..", import.meta.url))

const sourceExtension = /\.(?:[cm]?[jt]sx?)$/

const isProjectSource = (root: string, file: string): boolean => {
  const projectPath = relative(root, isAbsolute(file) ? file : resolve(root, file))
  return projectPath !== "" &&
    !projectPath.startsWith("..") &&
    sourceExtension.test(projectPath) &&
    !projectPath.split(/[\\/]/).some((part) =>
      part === "node_modules" ||
      part === ".git" ||
      part === "dist" ||
      part === "build" ||
      part === "coverage" ||
      part === ".data" ||
      part === "references"
    )
}

const isIgnored = (file: string): boolean =>
  file.split(/[\\/]/).some((part) =>
    part === "node_modules" ||
    part === ".git" ||
    part === "dist" ||
    part === "build" ||
    part === "coverage" ||
    part === ".data" ||
    part === "references"
  )

const writeJson = (response: ServerResponse, value: unknown, status = 200): void => {
  response.statusCode = status
  response.setHeader("content-type", "application/json; charset=utf-8")
  response.setHeader("cache-control", "no-store")
  response.end(JSON.stringify(value))
}

const readJson = (request: IncomingMessage): Promise<unknown> =>
  new Promise((resolveBody, reject) => {
    const chunks: Array<Buffer> = []
    let size = 0
    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > 1_000_000) {
        reject(new Error("Simulation requests are limited to 1 MB"))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on("end", () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      } catch (cause) {
        reject(cause)
      }
    })
    request.on("error", reject)
  })

const staleSimulation = (
  request: DevToolsProtocol.SimulationRequest,
  message: string
): DevToolsProtocol.SimulationFailed => ({
  _tag: "SimulationFailed",
  protocolVersion: DevToolsProtocol.protocolVersion,
  key: request.key,
  revision: request.revision,
  diagnostics: [{
    severity: "error",
    code: "simulation-stale",
    message,
    location: { file: request.source.file, line: null, column: null },
    statePath: null
  }]
})

const apiPlugin = (
  root: string,
  registry: MachineRegistry.MachineRegistry["Service"],
  inspector: ProjectInspector.ProjectInspector["Service"]
): Plugin => ({
  name: "effect-machine-devtools-api",
  configureServer(server) {
    server.middlewares.use((request: IncomingMessage, response: ServerResponse, next: () => void) => {
      if (request.method === "GET" && request.url === "/api/machines") {
        void Effect.runPromise(registry.get).then(
          (snapshot) => writeJson(response, snapshot),
          (cause) => {
            response.statusCode = 500
            response.end(String(cause))
          }
        )
        return
      }
      if (request.method === "POST" && request.url === "/api/simulations") {
        void Effect.runPromise(
          Effect.gen(function*() {
            const body = yield* Effect.tryPromise({
              try: () => readJson(request),
              catch: (cause) => cause
            })
            const simulationRequest = yield* Schema.decodeUnknownEffect(DevToolsProtocol.SimulationRequest)(body)
            const snapshot = yield* registry.get
            const current = snapshot.results.find((result) => result.key === simulationRequest.key)
            if (current === undefined || current._tag === "Failed") {
              return staleSimulation(simulationRequest, "The machine is no longer available; restart the simulation")
            }
            if (
              current.document.revision !== simulationRequest.revision ||
              current.document.source?.file !== simulationRequest.source.file ||
              current.document.source.exportName !== simulationRequest.source.exportName
            ) {
              return staleSimulation(
                simulationRequest,
                "The machine changed; restart the simulation from its latest revision"
              )
            }
            return yield* inspector.simulate(simulationRequest, { root })
          })
        ).then(
          (result) => writeJson(response, result),
          (cause) => writeJson(response, { message: String(cause) }, 400)
        )
        return
      }
      if (request.url !== "/api/events") {
        next()
        return
      }

      response.statusCode = 200
      response.setHeader("content-type", "text/event-stream")
      response.setHeader("cache-control", "no-cache, no-transform")
      response.setHeader("connection", "keep-alive")
      response.flushHeaders()

      const controller = new AbortController()
      request.on("close", () => controller.abort())
      void Effect.runPromise(
        registry.changes.pipe(
          Stream.runForEach((snapshot) => Effect.sync(() => response.write(`data: ${JSON.stringify(snapshot)}\n\n`)))
        ),
        { signal: controller.signal }
      ).catch(() => undefined)
    })
  }
})

const acquire = (
  ErrorType: DevServerErrorConstructor,
  options: DevServer.Options,
  registry: MachineRegistry.MachineRegistry["Service"],
  inspector: ProjectInspector.ProjectInspector["Service"]
): Effect.Effect<ViteDevServer, DevServer.DevServerError, never> =>
  Effect.tryPromise({
    try: async () => {
      const server = await createServer({
        root: packageRoot,
        appType: "spa",
        logLevel: "error",
        plugins: [apiPlugin(options.root, registry, inspector)],
        server: {
          host: options.host,
          port: options.port,
          strictPort: true,
          open: options.open ?? false
        }
      })
      await server.listen()
      return server
    },
    catch: (cause) =>
      new ErrorType({
        message: `Could not start the Effect Machine visualizer on ${options.host}:${options.port}`,
        cause
      })
  })

const acquireWatcher = (
  options: DevServer.Options,
  registry: MachineRegistry.MachineRegistry["Service"]
): Effect.Effect<FSWatcher> =>
  Effect.sync(() => {
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    const watcher = watch(options.root, watcherOptions(options))
    watcher.on("all", (_event, file) => {
      if (!isProjectSource(options.root, file)) return
      if (refreshTimer !== undefined) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => {
        Effect.runFork(
          registry.refresh.pipe(
            Effect.catch((cause) => Effect.logWarning("Machine reload failed", cause))
          )
        )
      }, options.debounce ?? 150)
    })
    watcher.on("close", () => {
      if (refreshTimer !== undefined) clearTimeout(refreshTimer)
    })
    watcher.on("error", (cause) => {
      Effect.runFork(Effect.logError("Machine file watcher failed", cause))
    })
    return watcher
  })

export const watcherOptions = (options: DevServer.Options): ChokidarOptions =>
  ({
    ignoreInitial: true,
    interval: 200,
    usePolling: options.watchPolling ?? false,
    ignored: (file, stats) => isIgnored(file) || stats?.isFile() === true && !sourceExtension.test(file)
  }) satisfies ChokidarOptions

export const run = (
  ErrorType: DevServerErrorConstructor,
  options: DevServer.Options
): Effect.Effect<
  never,
  DevServer.DevServerError,
  MachineRegistry.MachineRegistry | ProjectInspector.ProjectInspector
> =>
  Effect.gen(function*() {
    const registry = yield* MachineRegistry.MachineRegistry
    const inspector = yield* ProjectInspector.ProjectInspector
    const server = yield* Effect.acquireRelease(
      acquire(ErrorType, options, registry, inspector),
      (server) => Effect.promise(() => server.close())
    )
    yield* Effect.acquireRelease(
      acquireWatcher(options, registry),
      (watcher) => Effect.promise(() => watcher.close())
    )
    const address = server.resolvedUrls?.local[0] ?? `http://${options.host}:${options.port}/`
    yield* Effect.logInfo(`Effect Machine visualizer: ${address}`)
    return yield* Effect.never
  }).pipe(Effect.scoped)
