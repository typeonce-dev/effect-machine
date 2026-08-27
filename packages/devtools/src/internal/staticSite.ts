import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { fileURLToPath } from "node:url"
import { build as buildVite } from "vite"
import PackageJson from "../../package.json" with { type: "json" }
import * as DevToolsProtocol from "../DevToolsProtocol.js"
import * as MachineDocument from "../MachineDocument.js"
import * as ProjectInspector from "../ProjectInspector.js"

export interface Options {
  readonly root: string
  readonly include?: string | undefined
  readonly outputDirectory: string
}

export interface BuildResult {
  readonly outputDirectory: string
  readonly machineIds: ReadonlyArray<string>
}

export class StaticSiteError extends Schema.Error<StaticSiteError>(
  "@typeonce/effect-machine-devtools/internal/StaticSiteError"
)({
  _tag: Schema.tag("StaticSiteError"),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

const packageRoot = fileURLToPath(new URL("../..", import.meta.url))
const generatedMarker = ".effect-machine-site"
const staticDataMeta = "<meta name=\"effect-machine-static-data\" content=\"./machines.json\" />"

const prettyJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

export const staticIndex = (index: string): Effect.Effect<string, StaticSiteError> => {
  if (!index.includes("</head>")) {
    return Effect.fail(
      new StaticSiteError({
        message: "The visualizer index does not contain a closing head element"
      })
    )
  }
  return Effect.succeed(index.replace("</head>", `  ${staticDataMeta}\n  </head>`))
}

const formatFailures = (failures: ReadonlyArray<DevToolsProtocol.Failed>): string =>
  failures.map((failure) => {
    const messages = failure.diagnostics.map((diagnostic) => diagnostic.message).join("; ")
    return `- ${failure.key}: ${messages}`
  }).join("\n")

const ensureReplaceable = Effect.fnUntraced(
  function*(
    fs: FileSystem.FileSystem,
    path: Path.Path,
    outputDirectory: string
  ) {
    if (!(yield* fs.exists(outputDirectory))) return
    if (yield* fs.exists(path.join(outputDirectory, generatedMarker))) return
    const entries = yield* fs.readDirectory(outputDirectory)
    if (entries.length === 0) return
    return yield* new StaticSiteError({
      message: `Refusing to replace non-generated directory: ${outputDirectory}`
    })
  },
  (effect, _fs, _path, outputDirectory) =>
    effect.pipe(
      Effect.mapError((cause) =>
        cause instanceof StaticSiteError
          ? cause
          : new StaticSiteError({
            message: `Could not inspect output directory: ${outputDirectory}`,
            cause
          })
      )
    )
)

const inspect = Effect.fnUntraced(function*(options: Options) {
  const inspector = yield* ProjectInspector.ProjectInspector
  const results = yield* inspector.inspect({
    root: options.root,
    include: options.include,
    revision: 1
  })
  const failures = results.filter((result): result is DevToolsProtocol.Failed => result._tag === "Failed")
  if (failures.length > 0) {
    return yield* new StaticSiteError({
      message: `Static site generation failed for ${failures.length} machine candidate${
        failures.length === 1 ? "" : "s"
      }:\n${formatFailures(failures)}`
    })
  }
  const ready = results
    .filter((result): result is DevToolsProtocol.Ready => result._tag === "Ready")
    .sort((left, right) => left.key.localeCompare(right.key))
  if (ready.length === 0) {
    return yield* new StaticSiteError({
      message: `No Effect Machine definitions were found under ${options.root}`
    })
  }
  const snapshot = yield* Schema.decodeUnknownEffect(DevToolsProtocol.RegistrySnapshot)({
    protocolVersion: DevToolsProtocol.protocolVersion,
    revision: 1,
    results: ready
  }).pipe(
    Effect.mapError((cause) =>
      new StaticSiteError({
        message: "The generated machine registry is invalid",
        cause
      })
    )
  )
  return { ready, snapshot }
})

export const build = (options: Options): Effect.Effect<
  BuildResult,
  StaticSiteError,
  FileSystem.FileSystem | Path.Path | ProjectInspector.ProjectInspector
> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = path.resolve(options.root)
    const outputDirectory = path.resolve(options.outputDirectory)
    if (outputDirectory === root || path.dirname(outputDirectory) === outputDirectory) {
      return yield* new StaticSiteError({
        message: `Refusing to replace project or filesystem root: ${outputDirectory}`
      })
    }
    yield* ensureReplaceable(fs, path, outputDirectory)
    const { ready, snapshot } = yield* inspect({ ...options, root })
    const parent = path.dirname(outputDirectory)
    yield* fs.makeDirectory(parent, { recursive: true })

    return yield* Effect.acquireUseRelease(
      fs.makeTempDirectory({ directory: parent, prefix: ".effect-machine-site-" }),
      (stagingDirectory) =>
        Effect.gen(function*() {
          yield* Effect.tryPromise({
            try: () =>
              buildVite({
                root: packageRoot,
                base: "./",
                configFile: false,
                logLevel: "error",
                build: {
                  outDir: stagingDirectory,
                  emptyOutDir: true
                }
              }),
            catch: (cause) =>
              new StaticSiteError({
                message: "Could not bundle the static visualizer",
                cause
              })
          })

          const indexPath = path.join(stagingDirectory, "index.html")
          const index = yield* fs.readFileString(indexPath)
          yield* fs.writeFileString(indexPath, yield* staticIndex(index))
          yield* fs.writeFileString(path.join(stagingDirectory, "machines.json"), prettyJson(snapshot))
          yield* fs.writeFileString(
            path.join(stagingDirectory, "manifest.json"),
            prettyJson({
              formatVersion: 1,
              generator: {
                name: PackageJson.name,
                version: PackageJson.version
              },
              protocolVersion: DevToolsProtocol.protocolVersion,
              machineDocumentSchemaVersion: MachineDocument.schemaVersion,
              machines: ready.map((result) => ({
                key: result.key,
                machineId: result.document.machineId,
                source: result.document.source
              }))
            })
          )
          yield* fs.writeFileString(
            path.join(stagingDirectory, generatedMarker),
            `${PackageJson.name}@${PackageJson.version}\n`
          )

          yield* ensureReplaceable(fs, path, outputDirectory)
          if (yield* fs.exists(outputDirectory)) {
            yield* fs.remove(outputDirectory, { recursive: true })
          }
          yield* fs.rename(stagingDirectory, outputDirectory)
          return {
            outputDirectory,
            machineIds: ready.map((result) => result.document.machineId)
          }
        }),
      (stagingDirectory) => fs.remove(stagingDirectory, { recursive: true }).pipe(Effect.ignore)
    )
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof StaticSiteError
        ? cause
        : new StaticSiteError({
          message: "Could not build the Effect Machine static site",
          cause
        })
    )
  )
