import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const repositoryRoot = resolve(import.meta.dirname, "..")
const packageRoot = join(repositoryRoot, "packages", "oxlint-plugin")
const destination = await mkdtemp(join(tmpdir(), "effect-machine-oxlint-pack-"))
const consumer = join(destination, "consumer")
const oxlint = join(consumer, "node_modules", ".bin", "oxlint")

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

try {
  const packed = run("pnpm", ["pack", "--pack-destination", destination], {
    cwd: packageRoot
  })
  const archive = packed.stdout.trim().split("\n").at(-1)
  if (archive === undefined) throw new Error("pnpm pack did not return an archive path")

  const listing = run("tar", ["-tzf", archive]).stdout.trim().split("\n")
  const required = [
    "package/dist/index.js",
    "package/dist/index.d.ts",
    "package/dist/recommended.js",
    "package/dist/recommended.d.ts",
    "package/package.json",
    "package/README.md",
    "package/LICENSE",
    "package/NOTICE"
  ]
  for (const file of required) {
    if (!listing.includes(file)) throw new Error(`tarball is missing ${file}`)
  }
  const forbidden = listing.filter((file) => /^package\/(?:test|tsconfig)/.test(file))
  if (forbidden.length > 0) {
    throw new Error(`tarball contains repository-only files:\n${forbidden.join("\n")}`)
  }

  await mkdir(consumer)
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      devDependencies: {
        "@typeonce/oxlint-plugin-effect-machine": `file:${archive}`,
        oxlint: "1.80.0"
      }
    }, null, 2)
  )
  run("pnpm", ["install", "--prefer-offline", "--ignore-scripts"], { cwd: consumer })
  await writeFile(
    join(consumer, ".oxlintrc.json"),
    JSON.stringify({
      jsPlugins: ["@typeonce/oxlint-plugin-effect-machine"],
      rules: { "effect-machine/no-redundant-resolve": "error" }
    }, null, 2)
  )

  const fixture = join(consumer, "machine.ts")
  await writeFile(
    fixture,
    `import { Machine } from "@typeonce/effect-machine"\nMachine.make({ initial: (to) => to.Ready().resolve(({ target }) => target.from()) })\n`
  )

  run(process.execPath, [
    "--input-type=module",
    "--eval",
    `const plugin = (await import("@typeonce/oxlint-plugin-effect-machine")).default;
     const { recommended } = await import("@typeonce/oxlint-plugin-effect-machine/recommended");
     if (plugin.meta?.name !== "effect-machine" || Object.keys(plugin.rules).length !== 3) process.exit(1);
     if (Object.keys(recommended).length !== 3) process.exit(1);`
  ], { cwd: consumer })

  const lint = spawnSync(oxlint, ["-c", ".oxlintrc.json", "machine.ts"], {
    cwd: consumer,
    encoding: "utf8"
  })
  const lintOutput = `${lint.stdout ?? ""}\n${lint.stderr ?? ""}`
  if (lint.status === 0 || !lintOutput.includes("effect-machine(no-redundant-resolve)")) {
    throw new Error(`packed plugin did not report no-redundant-resolve\n${lintOutput.trim()}`)
  }

  run(oxlint, ["-c", ".oxlintrc.json", "--fix", "machine.ts"], { cwd: consumer })
  const fixed = await readFile(fixture, "utf8")
  if (!fixed.includes("initial: (to) => to.Ready()") || fixed.includes(".resolve(")) {
    throw new Error(`packed plugin did not apply its fixer\n${fixed}`)
  }

  console.log("packed Oxlint plugin import, configuration, diagnostic, and fixer passed")
} finally {
  await rm(destination, { recursive: true, force: true })
}
