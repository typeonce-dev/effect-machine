#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import PackageJson from "../package.json" with { type: "json" }
import * as DevServer from "./DevServer.js"
import * as StaticSite from "./internal/staticSite.js"
import * as MachineRegistry from "./MachineRegistry.js"
import * as ProjectInspector from "./ProjectInspector.js"

const root = Flag.directory("root", { mustExist: true }).pipe(
  Flag.withDescription("Project root to inspect"),
  Flag.withDefault(process.cwd())
)

const include = Flag.string("include").pipe(
  Flag.withDescription("Machine source glob relative to the project root"),
  Flag.withDefault("**/src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}")
)

const host = Flag.string("host").pipe(
  Flag.withDescription("Host for the local visualizer"),
  Flag.withDefault("127.0.0.1")
)

const port = Flag.integer("port").pipe(
  Flag.withDescription("Port for the local visualizer"),
  Flag.withDefault(5173)
)

const open = Flag.boolean("open").pipe(
  Flag.withDescription("Open the visualizer in the default browser"),
  Flag.withDefault(false)
)

const watchPolling = Flag.boolean("watch-polling").pipe(
  Flag.withDescription("Use polling instead of native file-system events"),
  Flag.withDefault(false)
)

const outputDirectory = Flag.directory("out-dir").pipe(
  Flag.withAlias("o"),
  Flag.withDescription("Directory to write the static website"),
  Flag.withDefault(".effect-machine/site")
)

const base = Command.make("effect-machine", { host, port, open, watchPolling }).pipe(
  Command.withSharedFlags({ root, include }),
  Command.withDescription("Inspect and publish Effect Machine visualizations")
)

const dev = base.pipe(
  Command.withDescription("Inspect Effect Machine definitions in a live local visualizer"),
  Command.withHandler(({ host, include, open, port, root, watchPolling }) => {
    const RegistryLayer = MachineRegistry.layer({ root, include }).pipe(
      Layer.provideMerge(ProjectInspector.layer)
    )
    return DevServer.run({ root, host, port, open, watchPolling }).pipe(Effect.provide(RegistryLayer))
  })
)

const build = Command.make("build", { outputDirectory }).pipe(
  Command.withDescription("Generate a static website from the project's machines"),
  Command.withHandler(Effect.fnUntraced(function*({ outputDirectory }) {
    const { include, root } = yield* base
    const result = yield* StaticSite.build({ root, include, outputDirectory }).pipe(
      Effect.provide(ProjectInspector.layer)
    )
    yield* Console.log(
      `Effect Machine static site: ${result.outputDirectory}\n${result.machineIds.length} machine${
        result.machineIds.length === 1 ? "" : "s"
      }: ${result.machineIds.join(", ")}`
    )
  }))
)

const cli = dev.pipe(Command.withSubcommands([build]))

Command.run(cli, { version: PackageJson.version }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
)
