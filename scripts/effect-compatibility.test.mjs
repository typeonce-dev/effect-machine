import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import test from "node:test"

test("latest Effect checks advance development pins while preserving consumer ranges", async () => {
  const root = await mkdtemp(join(tmpdir(), "effect-compatibility-"))
  try {
    await mkdir(join(root, "scripts"))
    await mkdir(join(root, "bin"))
    await mkdir(join(root, "packages", "fixture"), { recursive: true })
    await copyFile(new URL("./prepare-effect-compatibility.mjs", import.meta.url), join(root, "scripts", "prepare.mjs"))
    const pnpm = join(root, "bin", "pnpm")
    await writeFile(pnpm, `#!/usr/bin/env node\nprocess.stdout.write('["4.9.99","4.10.0","4.0.0"]')\n`)
    await chmod(pnpm, 0o755)
    await writeFile(join(root, "package.json"), JSON.stringify({
      devDependencies: { effect: "4.0.0", "@effect/vitest": "4.0.0", typescript: "6.0.3" }
    }))
    const manifestPath = join(root, "packages", "fixture", "package.json")
    await writeFile(manifestPath, JSON.stringify({
      dependencies: { "@effect/platform-node": "^4.0.0" },
      peerDependencies: { effect: "^4.0.0" },
      devDependencies: { effect: "4.0.0" }
    }))
    await writeFile(join(root, "pnpm-workspace.yaml"),
      'packages:\n  - "packages/*"\n\noverrides:\n  effect: 4.0.0\n  "@effect/vitest": 4.0.0\n  "@effect/platform-node": 4.0.0\n  unrelated: 1.0.0\n\nminimumReleaseAge: 1440\n')
    const result = spawnSync(process.execPath, [join(root, "scripts", "prepare.mjs")], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${join(root, "bin")}${delimiter}${process.env.PATH}` }
    })
    assert.equal(result.status, 0, result.stderr)
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    assert.deepEqual(manifest, {
      dependencies: { "@effect/platform-node": "^4.0.0" },
      peerDependencies: { effect: "^4.0.0" },
      devDependencies: { effect: "4.10.0" }
    })
    assert.deepEqual(JSON.parse(await readFile(join(root, "package.json"), "utf8")).devDependencies, {
      effect: "4.10.0",
      "@effect/vitest": "4.10.0",
      typescript: "6.0.3"
    })
    const workspace = await readFile(join(root, "pnpm-workspace.yaml"), "utf8")
    assert.match(workspace, /effect: 4\.10\.0/)
    assert.match(workspace, /"@effect\/vitest": 4\.10\.0/)
    assert.match(workspace, /"@effect\/platform-node": 4\.10\.0/)
    assert.match(workspace, /unrelated: 1\.0\.0/)
    assert.match(workspace, /minimumReleaseAge: 1440/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
