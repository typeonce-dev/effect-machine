import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const root = resolve(import.meta.dirname, "..")
const fixture = await mkdtemp(join(tmpdir(), "effect-machine-sync-"))
const run = (...args) =>
  spawnSync(process.execPath, [join(root, "scripts/sync-effect.mjs"), fixture, ...args], {
    cwd: root,
    encoding: "utf8"
  })

const write = run()
if (write.status !== 0) throw new Error(write.stderr || write.stdout)
const check = run("--check")
if (check.status !== 0) throw new Error(check.stderr || check.stdout)

const target = join(fixture, "packages/effect/src/unstable/machine/Machine.ts")
await writeFile(target, `${await readFile(target, "utf8")}\n// drift\n`)
const drift = run("--check")
if (drift.status === 0) throw new Error("sync check did not detect drift")

console.log("sync write, clean check, and drift detection passed")
