import { spawnSync } from "node:child_process"

const options = {
  base: "origin/main",
  head: "HEAD"
}

for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index]
  if (argument === "--base" || argument === "--head") {
    const value = process.argv[index + 1]
    if (value === undefined) {
      throw new Error(`${argument} requires a git revision`)
    }
    options[argument.slice(2)] = value
    index += 1
  } else {
    throw new Error(`Unknown argument: ${argument}`)
  }
}

const diff = (filters) => {
  const result = spawnSync(
    "git",
    ["diff", "--name-only", "-z", `--diff-filter=${filters}`, `${options.base}...${options.head}`],
    { encoding: "utf8" }
  )
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Unable to inspect the pull request diff")
  }
  return result.stdout.split("\0").filter(Boolean)
}

const changedFiles = diff("ACDMRTUXB")
const releaseFiles = changedFiles.filter(
  (path) =>
    path.startsWith("src/") ||
    path.startsWith("packages/effect-machine/src/") ||
    path.startsWith("packages/devtools/src/") ||
    path === "package.json" ||
    path === "packages/effect-machine/package.json" ||
    path === "packages/devtools/package.json"
)

if (releaseFiles.length === 0) {
  console.log("No library or package-metadata changes require a changeset.")
  process.exit(0)
}

const changedChangesets = diff("AM").filter(
  (path) => /^\.changeset\/(?!README\.md$)[^/]+\.md$/.test(path)
)

if (changedChangesets.length === 0) {
  console.error("Library changes require a new or updated changeset.")
  console.error("Files requiring a changeset:")
  for (const path of releaseFiles) {
    console.error(`- ${path}`)
  }
  console.error("Run `pnpm changeset`, commit the generated file, and push again.")
  process.exit(1)
}

console.log(`Changeset policy satisfied by: ${changedChangesets.join(", ")}`)
