import { existsSync, readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"

const packageRoot = resolve(process.argv[2] ?? "packages/devtools")
const sourceRoot = resolve(packageRoot, "src")
const errors = []

const visit = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      visit(path)
    } else if (path.includes("/internal/") && entry.name === "index.ts") {
      errors.push(`Internal barrel modules are not allowed: ${path.slice(packageRoot.length + 1)}`)
    }
  }
}

visit(sourceRoot)

const publicIndex = resolve(sourceRoot, "index.ts")
if (!existsSync(publicIndex)) {
  errors.push("Missing src/index.ts")
} else if (readFileSync(publicIndex, "utf8").includes("/internal/")) {
  errors.push("src/index.ts must not expose internal modules")
}

const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"))
if (manifest.exports?.["./internal/*"] !== null) {
  errors.push('package.json must block the "./internal/*" export')
}

if (errors.length > 0) {
  console.error(errors.join("\n"))
  process.exitCode = 1
} else {
  console.log("Devtools architecture checks passed")
}
