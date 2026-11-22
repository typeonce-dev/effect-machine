import { spawnSync } from "node:child_process"
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises"
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

  // tsconfig.declarations.json emits declarations for exported values whose
  // types come from the package, so they must be nameable through public
  // entrypoints.
  const projects = ["tsconfig.json", "tsconfig.declarations.json"]
  const declarations = join(consumer, "declarations", "declarations.d.ts")
  const assertPublicDeclarations = async () => {
    const emitted = await readFile(declarations, "utf8")
    if (emitted.includes("/internal/")) {
      throw new Error(`consumer declarations reference package internals:\n${emitted}`)
    }
    await rm(join(consumer, "declarations"), { recursive: true, force: true })
  }

  for (const project of projects) {
    run(
      process.execPath,
      [join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"), "-p", join(consumer, project)],
      { cwd: consumer }
    )
  }
  await assertPublicDeclarations()
  // The consumer must also compile with the native TypeScript 7 compiler pinned
  // by tooling/typescript-7. TSGO_BIN selects another native compiler binary.
  for (const project of projects) {
    if (process.env.TSGO_BIN !== undefined) {
      run(process.env.TSGO_BIN, ["-p", join(consumer, project)], { cwd: consumer })
    } else {
      run(
        process.execPath,
        [
          join(repositoryRoot, "tooling", "typescript-7", "node_modules", "typescript", "bin", "tsc"),
          "-p",
          join(consumer, project)
        ],
        { cwd: consumer }
      )
    }
  }
  await assertPublicDeclarations()
  run(process.execPath, [join(consumer, "runtime.mjs")], { cwd: consumer })

  console.log(
    "packed root, reactivity, cluster, and testing entrypoints passed strict consumer validation with TypeScript 6 and 7"
  )
} finally {
  await rm(destination, { recursive: true, force: true })
}
