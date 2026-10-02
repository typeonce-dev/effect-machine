import { execFileSync } from "node:child_process"
import { readFile, readdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

// Run only in a disposable checkout. Published ranges remain unchanged; CI
// updates the exact development versions and workspace overrides together.
const root = resolve(import.meta.dirname, "..")
const metadata = JSON.parse(execFileSync("pnpm", ["view", "effect@4", "version", "--json"], {
  cwd: root,
  encoding: "utf8"
}))
const versions = Array.isArray(metadata) ? metadata : [metadata]
if (versions.length === 0 || versions.some((version) => typeof version !== "string" || !/^4\.\d+\.\d+$/.test(version))) {
  throw new Error("Expected stable Effect 4 versions from the registry")
}
versions.sort((left, right) => {
  const a = left.split(".").map(Number)
  const b = right.split(".").map(Number)
  return a[1] - b[1] || a[2] - b[2]
})
const version = versions.at(-1)
const directories = await readdir(resolve(root, "packages"), { withFileTypes: true })
const manifests = [
  resolve(root, "package.json"),
  ...directories.filter((entry) => entry.isDirectory()).map((entry) => resolve(root, "packages", entry.name, "package.json"))
]
const dependencies = new Set()
for (const path of manifests) {
  const manifest = JSON.parse(await readFile(path, "utf8"))
  for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const [name, range] of Object.entries(manifest[section] ?? {})) {
      if (name !== "effect" && !name.startsWith("@effect/")) continue
      if (!/^\^?4\.\d+\.\d+$/.test(range)) {
        throw new Error(`Unsupported Effect compatibility range for ${name}: ${range}`)
      }
      dependencies.add(name)
      if (section === "devDependencies") manifest[section][name] = version
    }
  }
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`)
}
const workspacePath = resolve(root, "pnpm-workspace.yaml")
const workspace = await readFile(workspacePath, "utf8")
const overrides = workspace.match(/^overrides:\n(?:[ \t].*\n|\n)*/m)?.[0]
if (overrides === undefined) throw new Error("Expected workspace overrides for the pinned development baseline")
let updated = overrides
for (const name of dependencies) {
  const key = name === "effect" ? name : `"${name}"`
  const line = `${key}:`
  const lines = updated.trimEnd().split("\n")
  const index = lines.findIndex((value) => value.trimStart().startsWith(line))
  if (index === -1) throw new Error(`Missing pinned workspace override for ${name}`)
  lines[index] = `  ${key}: ${version}`
  updated = `${lines.join("\n")}\n\n`
}
await writeFile(workspacePath, workspace.replace(overrides, updated))
process.stdout.write(`Checking Effect and matching ecosystem packages at ${version}; published ranges are unchanged.\n`)
