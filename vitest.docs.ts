import * as Doctest from "@effect/doctest/Plugin"
import { resolve } from "node:path"
import { defineConfig } from "vitest/config"

const source = (path: string) => resolve(import.meta.dirname, "packages/effect-machine/src", path)

export default defineConfig({
  plugins: [Doctest.plugin()],
  resolve: {
    alias: [
      { find: "@typeonce/effect-machine/testing", replacement: source("testing/index.ts") },
      { find: "@typeonce/effect-machine/reactivity", replacement: source("unstable/reactivity/index.ts") },
      { find: "@typeonce/effect-machine/cluster", replacement: source("unstable/cluster/index.ts") },
      { find: "@typeonce/effect-machine", replacement: source("index.ts") }
    ]
  },
  test: {
    passWithNoTests: true,
    testTimeout: 10_000,
    include: [],
    includeSource: ["packages/effect-machine/src/**/*.ts"]
  }
})
