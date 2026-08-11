import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  highlightCode,
  moduleRoute,
  normalizeBasePath,
  renderMarkdown,
  uniqueDeclarationIds
} from "./generate.mjs"

test("derives stable module routes from JSON paths", () => {
  assert.equal(moduleRoute("Machine.json"), "Machine")
  assert.equal(moduleRoute("unstable/cluster/ClusterMachine.json"), "unstable/cluster/ClusterMachine")
  assert.throws(() => moduleRoute("../Machine.json"), /safe site route/)
})

test("renders documentation prose while escaping source HTML", () => {
  assert.equal(
    renderMarkdown("**Details**\n\nUse `<Machine>` safely.\n\n- First\n- Second"),
    '<h4 class="prose-heading">Details</h4><p>Use <code>&lt;Machine&gt;</code> safely.</p><ul><li>First</li><li>Second</li></ul>'
  )
  assert.doesNotMatch(renderMarkdown("<script>alert(1)</script>"), /<script>/)
})

test("assigns deterministic unique anchors to duplicate declarations", () => {
  const first = { name: "Machine" }
  const second = { name: "Machine" }
  const ids = uniqueDeclarationIds([{ category: "models", declarations: [first, second] }])
  assert.equal(ids.get(first), "machine")
  assert.equal(ids.get(second), "machine-2")
})

test("highlights TypeScript without changing its source text", () => {
  const source = 'declare const make: <State extends string>(name: "idle") => State'
  const highlighted = highlightCode(source, "typescript")
  assert.match(highlighted, /syntax-keyword">declare/)
  assert.match(highlighted, /syntax-name">make/)
  assert.match(highlighted, /syntax-string">&quot;idle&quot;/)
  assert.doesNotMatch(highlighted, /syntax-name">\s/)
  assert.equal(
    highlighted.replace(/<[^>]+>/g, "")
      .replaceAll("&quot;", '"')
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">"),
    source
  )
  assert.doesNotMatch(highlightCode("<script>", "typescript"), /<script>/)
})

test("normalizes root, project, and custom-domain base paths", () => {
  assert.equal(normalizeBasePath(""), "/")
  assert.equal(normalizeBasePath("/"), "/")
  assert.equal(normalizeBasePath("/effect-machine"), "/effect-machine/")
  assert.equal(normalizeBasePath("/effect-machine/"), "/effect-machine/")
  assert.throws(() => normalizeBasePath("effect-machine"), /start with a slash/)
  assert.throws(() => normalizeBasePath("/../effect-machine"), /Invalid/)
})
