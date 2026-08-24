import { strict as assert } from "node:assert"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import { resolve } from "node:path"

const repositoryRoot = resolve(import.meta.dirname, "..")

const readJson = async (path) => JSON.parse(await readFile(resolve(repositoryRoot, path), "utf8"))

test("core and devtools release with the same version", async () => {
  const [changesets, core, devtools] = await Promise.all([
    readJson(".changeset/config.json"),
    readJson("packages/effect-machine/package.json"),
    readJson("packages/devtools/package.json")
  ])

  assert.equal(devtools.version, core.version)
  assert.equal(devtools.dependencies[core.name], "workspace:^")
  assert.ok(
    changesets.fixed.some((group) =>
      group.length === 2 &&
      group.includes(core.name) &&
      group.includes(devtools.name)
    ),
    "core and devtools must remain in the same Changesets fixed group"
  )
})
