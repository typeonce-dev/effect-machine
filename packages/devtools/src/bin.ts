#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import * as DevServer from "./DevServer.js"
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

const cli = Command.make("effect-machine", { root, include, host, port, open }).pipe(
  Command.withDescription("Inspect Effect Machine definitions in a live local visualizer"),
  Command.withHandler(({ host, include, open, port, root }) => {
    const RegistryLayer = MachineRegistry.layer({ root, include }).pipe(
      Layer.provideMerge(ProjectInspector.layer)
    )
    return DevServer.run({ root, host, port, open }).pipe(Effect.provide(RegistryLayer))
  })
)

Command.run(cli, { version: "0.1.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
)
