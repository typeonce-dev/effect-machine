import { strict as assert } from "node:assert"
import { test } from "node:test"
import { ReflectionKind } from "typedoc"
import { splitJsDocComment } from "./module-comment.mjs"
import { normalizeApiModule, validateApiDocumentation } from "./normalize.mjs"

test("parses an Effect-style leading module comment", () => {
  assert.deepEqual(
    splitJsDocComment(`
 * Schema-first machine definitions.
 *
 * @since 0.4.0
 `),
    {
      summary: "Schema-first machine definitions.",
      tags: [{ tag: "@since", content: "0.4.0" }]
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
 * @since 0.4.0
 `)
  assert.match(parsed.summary, /@since is code/)
  assert.deepEqual(parsed.tags, [{ tag: "@since", content: "0.4.0" }])
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
  assert.doesNotThrow(() => validateApiDocumentation("./Machine", normalized, ["make"]))

  const incomplete = structuredClone(normalized)
  incomplete.groups[0].declarations[0].examples = []
  assert.throws(
    () => validateApiDocumentation("./Machine", incomplete, ["make"]),
    /make: missing example/
  )
})

test("normalizes documented parameters into declaration-owned usage sections", () => {
  const reflection = {
    schemaVersion: "2.0",
    id: 1,
    name: "sample",
    variant: "project",
    kind: ReflectionKind.Project,
    flags: {},
    children: [{
      id: 2,
      name: "sample/Machine",
      variant: "declaration",
      kind: ReflectionKind.Module,
      flags: {},
      children: [{
        id: 3,
        name: "make",
        variant: "declaration",
        kind: ReflectionKind.Variable,
        flags: {},
        comment: {
          summary: [{ kind: "text", text: "Creates a machine." }],
          blockTags: [
            { tag: "@category", content: [{ kind: "text", text: "constructors" }] },
            { tag: "@since", content: [{ kind: "text", text: "1.0.0" }] }
          ]
        },
        type: {
          type: "reflection",
          declaration: {
            id: 4,
            name: "__type",
            variant: "declaration",
            kind: ReflectionKind.TypeLiteral,
            flags: {},
            signatures: [{
              id: 5,
              name: "__call",
              variant: "signature",
              kind: ReflectionKind.CallSignature,
              flags: {},
              parameters: [{
                id: 6,
                name: "config",
                variant: "param",
                kind: ReflectionKind.Parameter,
                flags: {},
                comment: { summary: [{ kind: "text", text: "Complete machine configuration." }] },
                type: {
                  type: "reflection",
                  declaration: {
                    id: 7,
                    name: "__type",
                    variant: "declaration",
                    kind: ReflectionKind.TypeLiteral,
                    flags: {},
                    children: [{
                      id: 8,
                      name: "id",
                      variant: "declaration",
                      kind: ReflectionKind.Property,
                      flags: { isOptional: true, isReadonly: true },
                      comment: { summary: [{ kind: "text", text: "Stable definition identifier." }] },
                      type: { type: "intrinsic", name: "string" }
                    }]
                  }
                }
              }],
              type: { type: "intrinsic", name: "unknown" }
            }]
          }
        }
      }]
    }]
  }
  const normalized = normalizeApiModule(reflection, [{
    owner: "make",
    title: "Machine configuration",
    roots: [{ declaration: "make", parameter: "config", label: "Configuration" }]
  }])
  const declaration = normalized.groups[0].declarations[0]
  assert.equal(declaration.usageSections[0].title, "Machine configuration")
  assert.equal(declaration.usageSections[0].roots[0].description, "Complete machine configuration.")
  assert.deepEqual(declaration.usageSections[0].roots[0].members.map((member) => member.name), ["id"])
  assert.equal(declaration.usageSections[0].roots[0].members[0].description, "Stable definition identifier.")
})

test("projects a nested API reflection into an ordered core workflow", () => {
  const reflection = {
    schemaVersion: "2.0",
    id: 1,
    name: "sample",
    variant: "project",
    kind: ReflectionKind.Project,
    flags: {},
    children: [{
      id: 2,
      name: "sample/Machine",
      variant: "declaration",
      kind: ReflectionKind.Module,
      flags: {},
      children: [{
        id: 3,
        name: "Definition",
        variant: "declaration",
        kind: ReflectionKind.Interface,
        flags: {},
        children: [{
          id: 4,
          name: "handle",
          variant: "declaration",
          kind: ReflectionKind.Property,
          flags: { isReadonly: true },
          comment: {
            summary: [{ kind: "text", text: "Adds typed state handlers." }],
            blockTags: [{ tag: "@since", content: [{ kind: "text", text: "1.0.0" }] }]
          },
          type: { type: "intrinsic", name: "unknown" }
        }]
      }, {
        id: 5,
        name: "Machine",
        variant: "declaration",
        kind: ReflectionKind.Namespace,
        flags: {},
        children: [{
          id: 6,
          name: "HandlerConfig",
          variant: "declaration",
          kind: ReflectionKind.Interface,
          flags: {},
          comment: { summary: [{ kind: "text", text: "State handler configuration." }] },
          children: [{
            id: 7,
            name: "entry",
            variant: "declaration",
            kind: ReflectionKind.Property,
            flags: { isOptional: true, isReadonly: true },
            comment: { summary: [{ kind: "text", text: "Runs when the state is entered." }] },
            type: { type: "intrinsic", name: "unknown" }
          }]
        }]
      }]
    }]
  }
  const usageSections = [{
    owner: "Definition",
    ownerKind: "interface",
    title: "State handler configuration",
    roots: [{ reflection: "Machine.HandlerConfig", label: "Active states" }]
  }]
  const referenceSections = [{
    title: "Implement state behavior",
    entries: [{
      reflection: "Definition.handle",
      label: "handle",
      kind: "method",
      owner: "Definition",
      ownerKind: "interface",
      usageSections: ["State handler configuration"]
    }]
  }]

  const normalized = normalizeApiModule(reflection, usageSections, referenceSections)
  const entry = normalized.referenceSections[0].entries[0]
  assert.deepEqual(entry.origin, { type: "reflection", reflection: "Definition.handle" })
  assert.equal(entry.api.name, "handle")
  assert.equal(entry.api.kind, "method")
  assert.equal(entry.api.signature, "readonly handle: unknown")
  assert.equal(entry.api.usageSections[0].title, "State handler configuration")
  assert.equal(entry.api.usageSections[0].roots[0].members[0].name, "entry")
})
