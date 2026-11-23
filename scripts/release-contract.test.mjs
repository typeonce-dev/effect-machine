import { strict as assert } from "node:assert"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import { resolve } from "node:path"

const repositoryRoot = resolve(import.meta.dirname, "..")

const readJson = async (path) => JSON.parse(await readFile(resolve(repositoryRoot, path), "utf8"))

test("all Effect Machine packages release with the same version", async () => {
  const [changesets, core, react, devtools, oxlintPlugin] = await Promise.all([
    readJson(".changeset/config.json"),
    readJson("packages/effect-machine/package.json"),
    readJson("packages/effect-machine-react/package.json"),
    readJson("packages/devtools/package.json"),
    readJson("packages/oxlint-plugin/package.json")
  ])

  assert.equal(react.version, core.version)
  assert.equal(devtools.version, core.version)
  assert.equal(oxlintPlugin.version, core.version)
  assert.equal(react.dependencies[core.name], "workspace:^")
  assert.equal(devtools.dependencies[core.name], "workspace:^")
  assert.ok(
    changesets.fixed.some((group) =>
      group.length === 4 &&
      group.includes(core.name) &&
      group.includes(react.name) &&
      group.includes(devtools.name) &&
      group.includes(oxlintPlugin.name)
    ),
    "all Effect Machine packages must remain in the same Changesets fixed group"
  )
})

// `ClusterMachine` needs the fix to `Entity.keepAlive` that Effect released in
// 4.1.5: on an older version, a machine silently loses crash recovery.
const effectRange = "^4.1.5"

test("Effect consumers accept stable 4.x from 4.1.5 while development versions stay synchronized", async () => {
  const [root, core, react, devtools] = await Promise.all([
    readJson("package.json"),
    readJson("packages/effect-machine/package.json"),
    readJson("packages/effect-machine-react/package.json"),
    readJson("packages/devtools/package.json")
  ])
  const effect = root.devDependencies.effect
  assert.match(effect, /^4\.\d+\.\d+$/)
  for (const manifest of [core, react, devtools]) {
    assert.equal(manifest.peerDependencies.effect, effectRange)
    assert.equal(manifest.devDependencies.effect, effect)
  }
  assert.equal(root.devDependencies["@effect/vitest"], effect)
  assert.equal(core.devDependencies["@effect/vitest"], effect)
  assert.equal(react.peerDependencies["@effect/atom-react"], effectRange)
  assert.equal(react.devDependencies["@effect/atom-react"], effect)
  for (const name of ["@effect/platform-browser", "@effect/platform-node", "@effect/platform-node-shared"]) {
    assert.equal(
      devtools.dependencies[name],
      effectRange,
      `${name} must accept the same stable Effect major as its peer`
    )
  }
})
