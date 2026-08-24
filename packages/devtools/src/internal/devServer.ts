import { type ChokidarOptions, type FSWatcher, watch } from "chokidar"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import type { IncomingMessage, ServerResponse } from "node:http"
import { isAbsolute, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createServer, type Plugin, type ViteDevServer } from "vite"
import type * as DevServer from "../DevServer.js"
import * as MachineRegistry from "../MachineRegistry.js"

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

const writeJson = (response: ServerResponse, value: unknown): void => {
  response.statusCode = 200
  response.setHeader("content-type", "application/json; charset=utf-8")
  response.setHeader("cache-control", "no-store")
  response.end(JSON.stringify(value))
}

const apiPlugin = (
  registry: MachineRegistry.MachineRegistry["Service"]
): Plugin => ({
  name: "effect-machine-devtools-api",
  configureServer(server) {
    server.middlewares.use((request: IncomingMessage, response: ServerResponse, next: () => void) => {
      if (request.url === "/api/machines") {
        void Effect.runPromise(registry.get).then(
          (snapshot) => writeJson(response, snapshot),
          (cause) => {
            response.statusCode = 500
            response.end(String(cause))
          }
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
  registry: MachineRegistry.MachineRegistry["Service"]
): Effect.Effect<ViteDevServer, DevServer.DevServerError, never> =>
  Effect.tryPromise({
    try: async () => {
      const server = await createServer({
        root: packageRoot,
        appType: "spa",
        logLevel: "error",
        plugins: [apiPlugin(registry)],
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
): Effect.Effect<never, DevServer.DevServerError, MachineRegistry.MachineRegistry> =>
  Effect.gen(function*() {
    const registry = yield* MachineRegistry.MachineRegistry
    const server = yield* Effect.acquireRelease(
      acquire(ErrorType, options, registry),
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
