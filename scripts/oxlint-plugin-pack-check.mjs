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
  const packed = run("npm", [
    "pack",
    "--cache",
    join(destination, "npm-cache"),
    "--pack-destination",
    destination,
    "--json"
  ], {
    cwd: packageRoot
  })
  const filename = JSON.parse(packed.stdout).at(0)?.filename
  if (filename === undefined) throw new Error("npm pack did not return an archive filename")
  const archive = join(destination, filename)

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
  const installedManifest = JSON.parse(
    await readFile(
      join(
        consumer,
        "node_modules",
        "@typeonce",
        "oxlint-plugin-effect-machine",
        "package.json"
      ),
      "utf8"
    )
  )
  const rootExport = installedManifest.exports?.["."]
  const recommendedExport = installedManifest.exports?.["./recommended"]
  if (
    rootExport?.types !== "./dist/index.d.ts" ||
    rootExport?.import !== "./dist/index.js" ||
    recommendedExport?.types !== "./dist/recommended.d.ts" ||
    recommendedExport?.import !== "./dist/recommended.js"
  ) {
    throw new Error("packed plugin entrypoints do not resolve to built files")
  }
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
     const expected = [
       "no-async-planning-callback",
       "no-browser-api-in-planning",
       "no-conflicting-invocation-identity",
       "no-nondeterministic-planning",
       "no-redundant-resolve",
       "prefer-inline-handle"
     ];
     const actual = Object.keys(plugin.rules).sort();
     const configured = Object.keys(recommended).map((rule) => rule.replace("effect-machine/", "")).sort();
     if (plugin.meta?.name !== "effect-machine" || JSON.stringify(actual) !== JSON.stringify(expected)) process.exit(1);
     if (JSON.stringify(configured) !== JSON.stringify(expected)) process.exit(1);`
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
