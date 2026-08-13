import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const root = resolve(import.meta.dirname, "..")
const destination = await mkdtemp(join(tmpdir(), "effect-machine-pack-"))

try {
  const packed = spawnSync("pnpm", ["pack", "--pack-destination", destination], {
    cwd: root,
    encoding: "utf8"
  })
  if (packed.status !== 0) throw new Error(packed.stderr || packed.stdout)
  const archive = packed.stdout.trim().split("\n").at(-1)
  if (!archive) throw new Error("pnpm pack did not return an archive path")

  const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" })
  if (listing.status !== 0) throw new Error(listing.stderr)
  const files = listing.stdout.trim().split("\n")
  const sourceFiles = (await readdir(join(root, "src"), { recursive: true }))
    .filter((file) => file.endsWith(".ts"))
    .map((file) => `package/src/${file.replaceAll("\\", "/")}`)
  const required = [
    ...sourceFiles,
    "package/dist/index.js",
    "package/dist/index.d.ts",
    "package/dist/unstable/reactivity/index.js",
    "package/dist/unstable/reactivity/index.d.ts",
    "package/dist/unstable/cluster/index.js",
    "package/dist/unstable/cluster/index.d.ts",
    "package/dist/testing/index.js",
    "package/dist/testing/index.d.ts",
    "package/package.json",
    "package/README.md",
    "package/docs/agent-guide.md",
    "package/LICENSE",
    "package/NOTICE"
  ]
  for (const file of required) {
    if (!files.includes(file)) throw new Error(`tarball is missing ${file}`)
  }
  const legacyBuildFiles = [
    "package/dist/reactivity.js",
    "package/dist/reactivity.d.ts",
    "package/dist/cluster.js",
    "package/dist/cluster.d.ts",
    "package/dist/testing.js",
    "package/dist/testing.d.ts"
  ].filter((file) => files.includes(file))
  if (legacyBuildFiles.length > 0) {
    throw new Error(`tarball contains legacy entrypoint artifacts:\n${legacyBuildFiles.join("\n")}`)
  }
  const forbidden = files.filter((file) => /^package\/(?:test|typetest|scripts|\.github|\.changeset)\//.test(file))
  if (forbidden.length > 0) throw new Error(`tarball contains repository files:\n${forbidden.join("\n")}`)
  console.log(`pack verification passed (${files.length} files)`)
} finally {
  await rm(destination, { recursive: true, force: true })
}
