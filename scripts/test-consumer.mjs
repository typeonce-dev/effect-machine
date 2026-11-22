import { spawnSync } from "node:child_process"
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { findUnnameablePublicNames } from "./public-declarations.mjs"

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

  // Every name a public declaration refers to must be writable by a consumer,
  // or TypeScript cannot emit a declaration that expands it.
  const typescript = createRequire(join(repositoryRoot, "package.json"))("typescript")
  const unnameable = await findUnnameablePublicNames(typescript, packageDirectory)
  if (unnameable.length > 0) {
    throw new Error(`public declarations refer to names no consumer can write:\n${unnameable.join("\n")}`)
  }

  // tsconfig.declarations.json emits declarations for every fixture, so the
  // types of their exported values must be nameable through public entrypoints.
  const projects = ["tsconfig.json", "tsconfig.declarations.json"]
  const fixtures = (await readdir(consumer)).filter((file) => file.endsWith(".ts"))
  // TypeScript expands a type alias the package stops exporting instead of
  // reporting an error, which changes consumer declarations silently. These
  // public aliases are printed in declarations.d.ts and the package still
  // builds without them, so this check is what keeps them exported.
  const printedAliases = ["Machine.Machine.EventConstructorInput<"]
  const assertPublicDeclarations = async () => {
    for (const fixture of fixtures) {
      const emitted = await readFile(join(consumer, "declarations", fixture.replace(/\.ts$/, ".d.ts")), "utf8")
      if (emitted.includes("/internal/")) {
        throw new Error(`consumer declarations for ${fixture} reference package internals:\n${emitted}`)
      }
      if (fixture === "declarations.ts") {
        const expanded = printedAliases.filter((alias) => !emitted.includes(alias))
        if (expanded.length > 0) {
          throw new Error(`consumer declarations no longer name ${expanded.join(", ")}:\n${emitted}`)
        }
      }
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
