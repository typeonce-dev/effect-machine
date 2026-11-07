import * as Source from "@effect/doctest/Source"
import { execFileSync } from "node:child_process"
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"

// Doctests execute examples without type checking them. Extract the same
// snippets and compile them so that a stale API cannot survive in an example
// whose wrong types happen to work at runtime.
const root = resolve(import.meta.dirname, "../..")
const output = join(root, ".data", "doc-examples")
const includeUnmarked = process.argv.includes("--all")

const sourceFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === "internal" ? [] : sourceFiles(path)
    return entry.name.endsWith(".ts") ? [path] : []
  })

// `--all` also compiles plain `ts` fences. Use it to audit examples that are not runnable yet.
const markRunnable = (text) => text.replace(/(\* ```ts)[ \t]*$/gm, "$1 import.meta.vitest")

const snippets = []
for (const file of sourceFiles(join(root, "packages/effect-machine/src"))) {
  const contents = readFileSync(file, "utf8")
  for (const snippet of Source.extract(includeUnmarked ? markRunnable(contents) : contents)) {
    snippets.push({ file: relative(root, file), snippet })
  }
}

rmSync(output, { recursive: true, force: true })
mkdirSync(output, { recursive: true })
const names = snippets.map(({ file, snippet }) => {
  const name = `${file.replaceAll(/[/.]/g, "_")}_${snippet.line}.ts`
  writeFileSync(join(output, name), `${snippet.source}\nexport {}\n`)
  return name
})
writeFileSync(
  join(output, "tsconfig.json"),
  JSON.stringify(
    {
      extends: join(root, "tsconfig.base.json"),
      include: ["./*.ts"],
      compilerOptions: {
        composite: false,
        incremental: false,
        noEmit: true,
        declaration: false,
        declarationMap: false,
        sourceMap: false,
        noUnusedLocals: false,
        rootDir: root,
        types: ["node"],
        paths: {
          "@typeonce/effect-machine": [join(root, "packages/effect-machine/src/index.ts")],
          "@typeonce/effect-machine/testing": [join(root, "packages/effect-machine/src/testing/index.ts")],
          "@typeonce/effect-machine/reactivity": [join(root, "packages/effect-machine/src/unstable/reactivity/index.ts")],
          "@typeonce/effect-machine/cluster": [join(root, "packages/effect-machine/src/unstable/cluster/index.ts")],
          "effect": [join(root, "packages/effect-machine/node_modules/effect/dist/index.d.ts")],
          "effect/*": [join(root, "packages/effect-machine/node_modules/effect/dist/*.d.ts")]
        }
      }
    },
    null,
    2
  )
)

try {
  execFileSync(join(root, "node_modules/.bin/tsc"), ["-p", join(output, "tsconfig.json"), "--pretty", "false"], {
    cwd: root,
    stdio: "pipe",
    encoding: "utf8"
  })
  console.log(`doc example types passed (${names.length} examples)`)
} catch (error) {
  process.stderr.write(error.stdout ?? String(error))
  process.exitCode = 1
}
