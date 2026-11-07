import { copyFileSync, cpSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

// The copies exist only while packing, so agents working in this repository read `ai-docs` and `LLMS.md` directly.
const root = resolve(import.meta.dirname, "../..")
const packageDirectory = join(root, "packages/effect-machine")

for (const file of ["AGENTS.md", "CLAUDE.md", "ai-docs"]) {
  rmSync(join(packageDirectory, file), { recursive: true, force: true })
}

if (!process.argv.includes("--clean")) {
  copyFileSync(join(root, "LLMS.md"), join(packageDirectory, "AGENTS.md"))
  copyFileSync(join(root, "LLMS.md"), join(packageDirectory, "CLAUDE.md"))
  cpSync(join(root, "ai-docs"), join(packageDirectory, "ai-docs"), { recursive: true })
}
