import { strict as assert } from "node:assert"
import { test } from "node:test"
import { ReflectionKind } from "typedoc"
import { splitJsDocComment } from "./module-comment.mjs"
import { normalizeApiModule } from "./normalize.mjs"

test("parses an Effect-style leading module comment", () => {
  assert.deepEqual(
    splitJsDocComment(`
 * Schema-first machine definitions.
 *
 * @since 4.0.0
 `),
    {
      summary: "Schema-first machine definitions.",
      tags: [{ tag: "@since", content: "4.0.0" }]
    }
  )
})

test("keeps tags inside code fences as example source", () => {
  const parsed = splitJsDocComment(`
 * Examples for a module.
 *
 * \`\`\`ts
 * const value = "@since is code"
 * \`\`\`
 *
 * @since 4.0.0
 `)
  assert.match(parsed.summary, /@since is code/)
  assert.deepEqual(parsed.tags, [{ tag: "@since", content: "4.0.0" }])
})

test("normalizes categories, signatures, examples, tags, and source links", () => {
  const reflection = {
    schemaVersion: "2.0",
    id: 1,
    name: "@typeonce/effect-machine",
    variant: "project",
    kind: ReflectionKind.Project,
    flags: {},
    children: [{
      id: 2,
      name: "@typeonce/effect-machine/Machine",
      variant: "declaration",
      kind: ReflectionKind.Module,
      flags: {},
      comment: {
        summary: [{ kind: "text", text: "Schema-first machine definitions." }],
        blockTags: [{ tag: "@since", content: [{ kind: "text", text: "4.0.0" }] }]
      },
      children: [{
        id: 3,
        name: "make",
        variant: "declaration",
        kind: ReflectionKind.Function,
        flags: {},
        signatures: [{
          id: 4,
          name: "make",
          variant: "signature",
          kind: ReflectionKind.CallSignature,
          flags: {},
          comment: {
            summary: [
              { kind: "text", text: "Creates a machine.\n\n**Example** (Creating a machine)\n\n" },
              { kind: "code", text: "```ts\nconst machine = make()\n```" }
            ],
            blockTags: [
              { tag: "@category", content: [{ kind: "text", text: "constructors" }] },
              { tag: "@since", content: [{ kind: "text", text: "4.0.0" }] },
              { tag: "@see", content: [{ kind: "text", text: "Machine" }] }
            ]
          },
          parameters: [],
          type: { type: "intrinsic", name: "unknown" },
          sources: [{
            fileName: "src/Machine.ts",
            line: 1,
            character: 1,
            url: "https://example.com/Machine.ts#L1"
          }]
        }],
        sources: [{
          fileName: "src/Machine.ts",
          line: 1,
          character: 1,
          url: "https://example.com/Machine.ts#L1"
        }]
      }]
    }]
  }

  const normalized = normalizeApiModule(reflection)
  assert.equal(normalized.description, "Schema-first machine definitions.")
  assert.equal(normalized.declarationCount, 1)
  assert.equal(normalized.groups[0].category, "constructors")
  assert.equal(normalized.groups[0].declarations[0].signature, "declare function make(): unknown")
  assert.equal(normalized.groups[0].declarations[0].examples[0].title, "Creating a machine")
  assert.deepEqual(normalized.groups[0].declarations[0].see, ["Machine"])
  assert.equal(normalized.sourceUrl, "https://example.com/Machine.ts#L1")
})
