import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as DevToolsProtocol from "../src/DevToolsProtocol.js"
import * as StaticSite from "../src/internal/staticSite.js"
import * as ProjectInspector from "../src/ProjectInspector.js"

const TestLayer = Layer.mergeAll(NodeServices.layer, ProjectInspector.layer)

const localExampleMachineIds = [
  "hierarchy-routing",
  "inspection-example",
  "invoke-gallery-child",
  "invoke-outcomes",
  "layout-resilience",
  "optional-parent-protocol",
  "parallel-completion",
  "parent-child-protocol",
  "planner-example",
  "required-parent-child",
  "transition-semantics"
]

describe("StaticSite", () => {
  it.effect("builds a validated static website from inspected machines", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "effect-machine-static-site-" })
      const outputDirectory = path.join(directory, "site")
      const result = yield* StaticSite.build({
        root: process.cwd(),
        include: "packages/devtools/src/internal/browser/{example-machine,*-example}.ts",
        outputDirectory
      })
      const index = yield* fs.readFileString(path.join(outputDirectory, "index.html"))
      const snapshot = yield* fs.readFileString(path.join(outputDirectory, "machines.json"))
      const manifest = yield* fs.readFileString(path.join(outputDirectory, "manifest.json"))
      const assets = yield* fs.readDirectory(path.join(outputDirectory, "assets"))

      assert.deepStrictEqual([...result.machineIds].sort(), localExampleMachineIds)
      assert.include(index, "<meta name=\"effect-machine-static-data\" content=\"./machines.json\" />")
      assert.match(index, /(?:src|href)="\.\/assets\//)
      assert.strictEqual(
        Schema.decodeUnknownSync(DevToolsProtocol.RegistrySnapshot)(JSON.parse(snapshot)).results.length,
        localExampleMachineIds.length
      )
      const parsedManifest = JSON.parse(manifest) as {
        readonly formatVersion?: unknown
        readonly protocolVersion?: unknown
        readonly machines?: ReadonlyArray<{ readonly machineId?: unknown }>
      }
      assert.strictEqual(parsedManifest.formatVersion, 1)
      assert.strictEqual(parsedManifest.protocolVersion, DevToolsProtocol.protocolVersion)
      assert.deepStrictEqual(
        parsedManifest.machines?.map(({ machineId }) => machineId).sort(),
        localExampleMachineIds
      )
      assert.isTrue(assets.some((asset) => asset.endsWith(".js")))
      assert.isTrue(assets.some((asset) => asset.endsWith(".css")))
    }).pipe(Effect.provide(TestLayer)))

  it.effect("refuses to generate an index without a head element", () =>
    Effect.gen(function*() {
      const failure = yield* Effect.flip(StaticSite.staticIndex("<html></html>"))
      assert.strictEqual(failure._tag, "StaticSiteError")
    }))

  it.effect("refuses to replace an unrelated non-empty directory", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const outputDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "effect-machine-static-site-" })
      yield* fs.writeFileString(path.join(outputDirectory, "notes.txt"), "keep me")
      const failure = yield* Effect.flip(StaticSite.build({
        root: process.cwd(),
        include: "packages/devtools/src/internal/browser/example-machine.ts",
        outputDirectory
      }))
      assert.include(failure.message, "Refusing to replace non-generated directory")
    }).pipe(Effect.provide(TestLayer)))
})
