import { copyFileSync, cpSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

// The copies are build outputs: the source of truth stays in `ai-docs` and `LLMS.md`.
const root = resolve(import.meta.dirname, "../..")
const packageDirectory = join(root, "packages/effect-machine")

copyFileSync(join(root, "LLMS.md"), join(packageDirectory, "AGENTS.md"))
copyFileSync(join(root, "LLMS.md"), join(packageDirectory, "CLAUDE.md"))
rmSync(join(packageDirectory, "ai-docs"), { recursive: true, force: true })
cpSync(join(root, "ai-docs"), join(packageDirectory, "ai-docs"), { recursive: true })
