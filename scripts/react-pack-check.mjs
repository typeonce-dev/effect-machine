import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const repositoryRoot = resolve(import.meta.dirname, "..")
const destination = await mkdtemp(join(tmpdir(), "effect-machine-react-pack-"))
const consumer = join(destination, "consumer")

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options
  })
  if (result.status !== 0) {
    throw new Error(
      [`${command} ${args.join(" ")} failed`, result.stdout?.trim(), result.stderr?.trim()]
        .filter(Boolean)
        .join("\n")
    )
  }
  return result
}

const pack = (directory) => {
  const result = run("pnpm", ["pack", "--pack-destination", destination], { cwd: directory })
  const archive = result.stdout.trim().split("\n").at(-1)
  if (archive === undefined) throw new Error(`pnpm pack did not return an archive for ${directory}`)
  return archive
}

try {
  const coreArchive = pack(join(repositoryRoot, "packages", "effect-machine"))
  const reactRoot = join(repositoryRoot, "packages", "effect-machine-react")
  const reactArchive = pack(reactRoot)
  const reactPackage = JSON.parse(await readFile(join(reactRoot, "package.json")))

  const listing = run("tar", ["-tzf", reactArchive]).stdout.trim().split("\n")
  for (const required of [
    "package/dist/index.js",
    "package/dist/index.d.ts",
    "package/dist/MachineAtom.js",
    "package/dist/MachineAtom.d.ts",
    "package/src/index.ts",
    "package/src/MachineAtom.ts",
    "package/package.json",
    "package/README.md",
    "package/LICENSE",
    "package/NOTICE"
  ]) {
    if (!listing.includes(required)) throw new Error(`tarball is missing ${required}`)
  }
  const forbidden = listing.filter((file) => /^package\/(?:test|typetest)\//.test(file))
  if (forbidden.length > 0) throw new Error(`tarball contains repository files:\n${forbidden.join("\n")}`)

  await mkdir(consumer, { recursive: true })
  await writeFile(join(consumer, "package.json"), JSON.stringify({
    private: true,
    type: "module",
    dependencies: {
      "@effect/atom-react": reactPackage.peerDependencies["@effect/atom-react"],
      "@typeonce/effect-machine": `file:${coreArchive}`,
      "@typeonce/effect-machine-react": `file:${reactArchive}`,
      effect: reactPackage.peerDependencies.effect,
      react: "19.2.7",
      scheduler: "0.27.0"
    }
  }, null, 2))
  await writeFile(
    join(consumer, "pnpm-workspace.yaml"),
    `packages:\n  - .\noverrides:\n  "@typeonce/effect-machine": "file:${coreArchive}"\n`
  )

  run("pnpm", ["install", "--prefer-offline", "--ignore-scripts"], { cwd: consumer })
  run(process.execPath, [
    "--input-type=module",
    "--eval",
    `const module = await import("@typeonce/effect-machine-react");
     if (typeof module.useMachineAtom !== "function") throw new Error("useMachineAtom is not exported");`
  ], { cwd: consumer })

  console.log(`React package verification passed (${listing.length} files)`)
} finally {
  await rm(destination, { recursive: true, force: true })
}
