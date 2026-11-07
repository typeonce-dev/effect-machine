import * as Source from "@effect/doctest/Source"
import { execFileSync } from "node:child_process"
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"

// Doctests execute examples without type checking them. Extract the same
// snippets and compile them so that a stale API cannot survive in an example
// whose wrong types happen to work at runtime. A plain `ts` fence would escape
// both, so every example in the published source must be runnable and titled.
const root = resolve(import.meta.dirname, "../..")
const output = join(root, ".data", "doc-examples")

const sourceFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === "internal" ? [] : sourceFiles(path)
    return entry.name.endsWith(".ts") ? [path] : []
  })

const documentedFiles = [
  ...sourceFiles(join(root, "packages/effect-machine/src")),
  ...sourceFiles(join(root, "packages/effect-machine-react/src"))
]
const problems = documentedFiles.flatMap((file) =>
  readFileSync(file, "utf8").split("\n").flatMap((line, index) => {
    const location = `${relative(root, file)}:${index + 1}`
    if (/^\s*\*\s*```ts\s*$/.test(line)) return [`${location} is not runnable. Use \`\`\`ts import.meta.vitest`]
    if (/^\s*\*\s*\*\*Example\*\*\s*$/.test(line)) return [`${location} has no title. Use **Example** (Short title)`]
    return []
  })
)
if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`)
  process.exit(1)
}

const snippets = []
for (const file of sourceFiles(join(root, "packages/effect-machine/src"))) {
  for (const snippet of Source.extract(readFileSync(file, "utf8"))) {
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
