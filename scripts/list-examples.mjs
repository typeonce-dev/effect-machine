import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const examplesRoot = resolve(root, "examples")
const examples = []

for (const entry of readdirSync(examplesRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) {
    continue
  }

  const directory = `examples/${entry.name}`
  const packageJsonPath = resolve(root, directory, "package.json")
  let packageJson

  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"))
  } catch (error) {
    throw new Error(`${directory} must contain a valid package.json`, { cause: error })
  }

  if (typeof packageJson.scripts?.check !== "string") {
    throw new Error(`${directory}/package.json must define a check script`)
  }

  examples.push({
    example: entry.name,
    directory
  })
}

if (examples.length === 0) {
  throw new Error("At least one package is required in examples/")
}

examples.sort((left, right) => left.example.localeCompare(right.example))
console.log(JSON.stringify(examples))
