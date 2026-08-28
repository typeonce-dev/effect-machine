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
