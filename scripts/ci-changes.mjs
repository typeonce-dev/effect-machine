import { execFileSync } from "node:child_process"
import { appendFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const performanceDependencies = new Set(["effect", "tinybench", "typescript"])

const dependencyVersions = (packageJson) => ({
  ...packageJson.dependencies,
  ...packageJson.devDependencies,
  ...packageJson.optionalDependencies,
  ...packageJson.peerDependencies
})

const relevantDependenciesChanged = (beforePackageJson, afterPackageJson) => {
  const before = dependencyVersions(beforePackageJson)
  const after = dependencyVersions(afterPackageJson)
  return [...performanceDependencies].some((dependency) => before[dependency] !== after[dependency])
}

export const classifyChanges = ({
  afterPackageJson,
  beforePackageJson,
  changedFiles
}) => {
  const sourceChanged = changedFiles.some((path) => path.startsWith("src/"))
  const dependencyChanged = relevantDependenciesChanged(beforePackageJson, afterPackageJson)
  const classifierChanged = changedFiles.includes("scripts/ci-changes.mjs")
  const typePerformance = sourceChanged ||
    dependencyChanged ||
    classifierChanged ||
    changedFiles.some((path) =>
      path.startsWith("perf/types/") ||
      path === "scripts/type-performance.mjs" ||
      path === "scripts/compare-type-performance.mjs" ||
      path === "tsconfig.json" ||
      path === "tsconfig.build.json" ||
      path === ".github/workflows/type-performance.yml"
    )
  const runtimePerformance = dependencyChanged ||
    classifierChanged ||
    changedFiles.some((path) =>
      path.startsWith("src/internal/machine/") ||
      path === "src/Machine.ts" ||
      path.startsWith("perf/runtime/") ||
      path === "scripts/runtime-performance.mjs" ||
      path === "scripts/compare-runtime-performance.mjs" ||
      path === "tsconfig.build.json" ||
      path === ".github/workflows/runtime-performance.yml"
    )
  return {
    runtimePerformance,
    typePerformance
  }
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" })

const readPackageJsonAt = (revision) => JSON.parse(git("show", `${revision}:package.json`))

const main = () => {
  const options = {
    base: undefined,
    githubOutput: undefined,
    head: undefined
  }
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index]
    if (argument === "--base" || argument === "--head" || argument === "--github-output") {
      const value = process.argv[index + 1]
      if (value === undefined) {
        throw new Error(`${argument} requires a value`)
      }
      options[argument === "--github-output" ? "githubOutput" : argument.slice(2)] = value
      index += 1
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  if (options.base === undefined || options.head === undefined) {
    throw new Error("Usage: node scripts/ci-changes.mjs --base <revision> --head <revision> [--github-output <path>]")
  }

  const changedFiles = git(
    "diff",
    "--name-only",
    "--diff-filter=ACDMRTUXB",
    `${options.base}...${options.head}`
  ).trim().split("\n").filter(Boolean)
  const result = classifyChanges({
    afterPackageJson: readPackageJsonAt(options.head),
    beforePackageJson: readPackageJsonAt(options.base),
    changedFiles
  })
  const output = [
    `type_performance=${result.typePerformance}`,
    `runtime_performance=${result.runtimePerformance}`
  ].join("\n")

  if (options.githubOutput === undefined) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    appendFileSync(options.githubOutput, `${output}\n`)
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main()
}
