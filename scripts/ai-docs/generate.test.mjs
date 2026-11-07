import { strict as assert } from "node:assert"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { directoryToMarkdown } from "./generate.mjs"

test("renders sections in order, inlining 0-prefixed examples and linking the rest", () => {
  const directory = mkdtempSync(join(tmpdir(), "ai-docs-"))
  try {
    writeFileSync(join(directory, "index.md"), "# Docs\n")
    mkdirSync(join(directory, "20_second"))
    writeFileSync(join(directory, "20_second", "index.md"), "## Second\n")
    mkdirSync(join(directory, "10_first", "fixtures"), { recursive: true })
    writeFileSync(join(directory, "10_first", "index.md"), "## First\n")
    writeFileSync(join(directory, "10_first", "fixtures", "ignored.ts"), "export const ignored = 1\n")
    writeFileSync(
      join(directory, "10_first", "01_inline.ts"),
      "/**\n * @title Inlined\n *\n * Explains it.\n */\nexport const inlined = 1\n"
    )
    writeFileSync(join(directory, "10_first", "10_linked-example.ts"), "export const linked = 1\n")

    assert.equal(
      directoryToMarkdown(directory),
      [
        "# Docs",
        "## First",
        "#### Inlined\n\nExplains it.\n\n```ts\nexport const inlined = 1\n```",
        "- **[Linked example](./10_first/10_linked-example.ts)**",
        "## Second"
      ].join("\n\n")
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
