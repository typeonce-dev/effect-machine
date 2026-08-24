import { spawnSync } from "node:child_process"
import { cp, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const repositoryRoot = resolve(import.meta.dirname, "..")
const root = join(repositoryRoot, "packages", "effect-machine")
const destination = await mkdtemp(join(tmpdir(), "effect-machine-consumer-"))

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options
  })

  if (result.status !== 0) {
    throw new Error(
      [`${command} ${args.join(" ")} failed`, result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join("\n")
    )
  }
}

try {
  run("pnpm", ["pack", "--pack-destination", destination], { cwd: root })

  const archives = (await readdir(destination)).filter((file) => file.endsWith(".tgz"))
  if (archives.length !== 1) {
    throw new Error(`expected one package archive, found ${archives.length}: ${archives.join(", ")}`)
  }

  const consumer = join(destination, "consumer")
  const packageDirectory = join(consumer, "node_modules", "@typeonce", "effect-machine")

  await cp(join(repositoryRoot, "scripts", "fixtures", "consumer"), consumer, {
    recursive: true
  })
  await mkdir(packageDirectory, { recursive: true })

  run("tar", ["-xzf", join(destination, archives[0]), "-C", packageDirectory, "--strip-components=1"], { cwd: root })

  await symlink(join(repositoryRoot, "node_modules", "effect"), join(consumer, "node_modules", "effect"), "dir")
  await mkdir(join(consumer, "node_modules", "@types"), { recursive: true })
  await symlink(
    join(repositoryRoot, "node_modules", "@types", "node"),
    join(consumer, "node_modules", "@types", "node"),
    "dir"
  )

  run(
    process.execPath,
    [join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"), "-p", join(consumer, "tsconfig.json")],
    { cwd: consumer }
  )
  if (process.env.TSGO_BIN !== undefined) {
    run(process.env.TSGO_BIN, ["-p", join(consumer, "tsconfig.json")], { cwd: consumer })
  }
  run(process.execPath, [join(consumer, "runtime.mjs")], { cwd: consumer })

  console.log("packed root, reactivity, cluster, and testing entrypoints passed strict consumer validation")
} finally {
  await rm(destination, { recursive: true, force: true })
}
