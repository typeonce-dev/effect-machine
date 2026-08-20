import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  highlightCode,
  githubRepository,
  moduleRoute,
  normalizeBasePath,
  normalizeGitHubStars,
  normalizeOrigin,
  parseChangelog,
  parseChangeset,
  renderChangelogPage,
  renderGuidePage,
  renderIndexPage,
  renderLayout,
  renderMarkdown,
  renderModulePage,
  renderRobots,
  renderSitemap,
  siteManifest,
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

test("renders fenced code with highlighting and copy controls", () => {
  const html = renderMarkdown(`Call the new API:

\`\`\`ts
const value = Machine.example("safe")
\`\`\`

Then reuse \`value\`.`)
  assert.match(html, /<p>Call the new API:<\/p>/)
  assert.match(html, /class="code-block code-block--markdown"/)
  assert.match(html, /aria-label="Copy ts code"/)
  assert.match(html, /syntax-keyword">const<\/span>/)
  assert.match(html, /syntax-string">&quot;safe&quot;<\/span>/)
  assert.match(html, /<p>Then reuse <code>value<\/code>\.<\/p>/)
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

const site = {
  basePath: "/docs/",
  description: "Schema-first state machines",
  githubStars: 1_234,
  modules: [{
    api: { declarationCount: 12, description: "State machine APIs" },
    export: "./Machine",
    label: "Machine",
    route: "Machine"
  }],
  navigation: [],
  origin: "https://docs.example.com",
  package: {
    name: "@typeonce/effect-machine",
    description: "Schema-first state machines",
    repositoryUrl: "https://github.com/typeonce-dev/effect-machine",
    sourceUrl: "https://github.com/typeonce-dev/effect-machine",
    version: "0.4.0"
  },
  socialImage: "social-card.png",
  themeColor: { light: "#fbfbfd", dark: "#111115" },
  title: "Effect Machine"
}

test("parses Changesets release entries and pending descriptions", () => {
  const releases = parseChangelog(`# Package

## 1.2.0

### Minor Changes

- abc1234: Add a typed \`make\` helper.

  Preserve inference across multiple lines.

  \`\`\`ts
  const machine = make()
  \`\`\`

### Patch Changes

- def5678: Fix escaped output.
`, new Map([["1.2.0", "2026-08-13"]]))
  assert.deepEqual(releases, [{
    version: "1.2.0",
    date: "2026-08-13",
    groups: [{
      type: "minor",
      entries: [{
        description: "Add a typed `make` helper.\n\nPreserve inference across multiple lines.\n\n```ts\nconst machine = make()\n```"
      }]
    }, {
      type: "patch",
      entries: [{ description: "Fix escaped output." }]
    }]
  }])
  assert.deepEqual(parseChangeset(`---
"@typeonce/effect-machine": minor
---

Add snapshot selectors.
`, "@typeonce/effect-machine"), { type: "minor", description: "Add snapshot selectors." })
  assert.equal(parseChangeset(`---
"another-package": patch
---

Ignore this package.
`, "@typeonce/effect-machine"), undefined)
})

test("renders a navigable changelog with release dates", () => {
  const html = renderChangelogPage({
    ...site,
    changelog: [{
      version: "1.2.0",
      date: "2026-08-13",
      groups: [{ type: "minor", entries: [{ description: "Add a feature." }] }]
    }]
  })
  assert.match(html, /class="navigation-changelog is-current"/)
  assert.match(html, /id="release-1-2-0">v1\.2\.0/)
  assert.match(html, /datetime="2026-08-13">August 13, 2026/)
  assert.match(html, /<li><p>Add a feature\.<\/p><\/li>/)
})

test("renders collapsible category navigation with declaration anchors", () => {
  const declaration = {
    name: "make",
    kind: "variable",
    description: "Creates a machine.",
    examples: [],
    see: []
  }
  const module = {
    api: {
      declarationCount: 1,
      description: "State machine APIs",
      groups: [{ category: "constructors", declarations: [declaration] }]
    },
    export: "./Machine",
    label: "Machine",
    route: "Machine"
  }
  const html = renderModulePage({ ...site, modules: [module] }, module)
  assert.match(html, /<details class="page-toc__group">/)
  assert.match(html, /<summary>[\s\S]*Constructors[\s\S]*<\/summary>/)
  assert.match(html, /<a href="#make">make<\/a>/)
  assert.match(html, /<h3 id="make">make<\/h3>/)
})

test("renders declaration-owned usage sections and documented members in the guide", () => {
  const declaration = {
    name: "make",
    kind: "variable",
    description: "Creates a machine.",
    examples: [],
    see: [],
    usageSections: [{
      owner: "make",
      title: "Machine configuration",
      description: "Parameters accepted by make.",
      roots: [{
        label: "Configuration",
        description: "Complete machine configuration.",
        examples: [],
        members: [{
          name: "id",
          signature: "readonly id?: string",
          description: "Stable definition identifier.",
          sourceUrl: "https://github.com/example/repo/blob/main/src/Machine.ts#L1",
          examples: [],
          parameters: [],
          members: []
        }]
      }]
    }]
  }
  const module = {
    api: {
      declarationCount: 1,
      description: "State machine APIs",
      referenceSections: [{
        title: "Create the definition",
        description: "Construct the machine.",
        entries: [{ origin: { type: "declaration", name: "make", kind: "variable" }, api: declaration }]
      }],
      groups: [{ category: "constructors", declarations: [declaration] }]
    },
    export: "./Machine",
    label: "Machine",
    route: "Machine"
  }
  const html = renderGuidePage({ ...site, modules: [module], guideModule: module })
  assert.doesNotMatch(html, />Machine configuration<\//)
  assert.match(html, /href="#make-usage-machine-configuration-configuration">Configuration<\/a>/)
  assert.match(html, /<h4 id="make-usage-machine-configuration-configuration">Configuration<\/h4>/)
  assert.match(html, /id="make-usage-machine-configuration-configuration-id" aria-labelledby="make-usage-machine-configuration-configuration-id-title"/)
  assert.match(html, /<h5 id="make-usage-machine-configuration-configuration-id-title">id<\/h5>/)
  assert.match(html, /<span class="syntax-keyword">readonly<\/span> id/)
  assert.match(html, /<span class="syntax-type">string<\/span>/)
  assert.match(html, /Stable definition identifier\./)
  assert.doesNotMatch(html, />Usage reference</)
  assert.ok(html.indexOf("id-title") < html.indexOf("Copy id signature"))
  assert.ok(html.indexOf("Copy id signature") < html.indexOf("Stable definition identifier."))
  assert.ok(html.indexOf(">Source</") < html.indexOf("Copy id signature"))
})

test("renders the ordered workflow only in the standalone guide", () => {
  const states = {
    name: "states",
    kind: "variable",
    description: "Defines state topology.",
    examples: [],
    see: [],
    usageSections: []
  }
  const make = {
    name: "make",
    kind: "variable",
    description: "Creates a definition.",
    examples: [],
    see: [],
    usageSections: []
  }
  const handlerUsage = {
    owner: "Definition",
    ownerKind: "interface",
    title: "State handler configuration",
    description: "State-local behavior.",
    roots: []
  }
  const definition = {
    name: "Definition",
    kind: "interface",
    description: "Reusable definition model.",
    examples: [],
    see: [],
    usageSections: [handlerUsage]
  }
  const helper = {
    name: "helper",
    kind: "function",
    description: "Supporting helper.",
    examples: [],
    see: [],
    usageSections: []
  }
  const handle = {
    name: "handle",
    kind: "method",
    description: "Adds typed state handlers.",
    examples: [],
    see: [],
    usageSections: [handlerUsage]
  }
  const module = {
    api: {
      declarationCount: 4,
      description: "State machine APIs",
      referenceSections: [{
        title: "Define state topology",
        description: "Start with the states.",
        entries: [{ origin: { type: "declaration", name: "states", kind: "variable" }, api: states }]
      }, {
        title: "Create the definition",
        description: "Construct and implement the machine.",
        entries: [
          { origin: { type: "declaration", name: "make", kind: "variable" }, api: make },
          { origin: { type: "reflection", reflection: "Definition.handle" }, api: handle }
        ]
      }],
      groups: [
        { category: "constructors", declarations: [helper, make, states] },
        { category: "models", declarations: [definition] }
      ]
    },
    export: "./Machine",
    label: "Machine",
    route: "Machine"
  }

  const guideSite = { ...site, modules: [module], guideModule: module }
  const guideHtml = renderGuidePage(guideSite)
  assert.ok(guideHtml.indexOf("Define state topology") < guideHtml.indexOf('id="states"'))
  assert.ok(guideHtml.indexOf('id="states"') < guideHtml.indexOf("Create the definition"))
  assert.match(guideHtml, /<h3 id="handle">handle<\/h3>/)
  assert.doesNotMatch(guideHtml, /id="helper"/)
  assert.match(guideHtml, /class="navigation-guide is-current"/)
  assert.ok(guideHtml.indexOf("navigation-changelog") < guideHtml.indexOf("navigation-guide is-current"))

  const moduleHtml = renderModulePage(guideSite, module)
  assert.match(moduleHtml, /<h3 id="helper">helper<\/h3>/)
  assert.match(moduleHtml, /<h3 id="make">make<\/h3>/)
  assert.match(moduleHtml, /<h3 id="states">states<\/h3>/)
  assert.match(moduleHtml, /<h3 id="definition">Definition<\/h3>/)
  assert.doesNotMatch(moduleHtml, /Define state topology/)
  assert.doesNotMatch(moduleHtml, /State handler configuration/)
  assert.doesNotMatch(moduleHtml, /id="handle"/)
})

test("renders canonical and social metadata without exposing the internal channel", () => {
  const html = renderLayout(site, {
    content: '<section class="reference-hero"><div class="eyebrow">API reference</div></section>',
    currentRoute: "Machine",
    pageKind: "module",
    title: "Machine · Effect Machine"
  })
  assert.match(html, /rel="canonical" href="https:\/\/docs\.example\.com\/docs\/Machine\/"/)
  assert.match(html, /property="og:image" content="https:\/\/docs\.example\.com\/docs\/social-card\.png"/)
  assert.match(html, /name="twitter:card" content="summary_large_image"/)
  assert.match(html, /rel="manifest" href="\/docs\/site\.webmanifest"/)
  assert.doesNotMatch(html, /v4 API reference/)
})

test("links the header to the repository root and exposes its star-count target", () => {
  const html = renderLayout(site, {
    content: "",
    currentRoute: "",
    pageKind: "overview",
    title: "Effect Machine"
  })
  assert.match(
    html,
    /href="https:\/\/github\.com\/typeonce-dev\/effect-machine" aria-label="View typeonce-dev\/effect-machine on GitHub \(1,234 GitHub stars\)"/
  )
  assert.match(html, /class="github-stars" title="1,234 GitHub stars"/)
  assert.match(html, /<span>1,234<\/span>/)
  assert.doesNotMatch(html, /class="github-stars"[^>]*(?:data-github-stars|hidden)/)
  assert.doesNotMatch(html, /github-link[^>]+\/tree\//)
})

test("omits the star badge when the build does not supply a count", () => {
  const html = renderLayout({ ...site, githubStars: undefined }, {
    content: "",
    currentRoute: "",
    pageKind: "overview",
    title: "Effect Machine"
  })
  assert.match(html, /aria-label="View typeonce-dev\/effect-machine on GitHub"/)
  assert.doesNotMatch(html, /class="github-stars"/)
})

test("accepts only non-negative safe integers for build-time GitHub stars", () => {
  assert.equal(normalizeGitHubStars(undefined), undefined)
  assert.equal(normalizeGitHubStars(""), undefined)
  assert.equal(normalizeGitHubStars("0"), 0)
  assert.equal(normalizeGitHubStars("1234"), 1_234)
  assert.throws(() => normalizeGitHubStars("-1"), /non-negative integer/)
  assert.throws(() => normalizeGitHubStars("1.5"), /non-negative integer/)
  assert.throws(() => normalizeGitHubStars("01"), /non-negative integer/)
  assert.throws(() => normalizeGitHubStars("9007199254740992"), /safe integer range/)
})

test("accepts only root GitHub repository URLs for the header integration", () => {
  assert.equal(githubRepository("https://github.com/typeonce-dev/effect-machine"), "typeonce-dev/effect-machine")
  assert.throws(
    () => githubRepository("https://github.com/typeonce-dev/effect-machine/tree/main"),
    /GitHub repository URL/
  )
  assert.throws(() => githubRepository("https://example.com/owner/repository"), /GitHub repository URL/)
})

test("keeps the internal Effect channel out of the homepage label", () => {
  const html = renderIndexPage({ ...site, channel: "v4" })
  assert.match(html, /<div class="eyebrow">API reference<\/div>/)
  assert.doesNotMatch(html, /v4 API reference/)
})

test("generates manifest, robots, and sitemap URLs from the deployment base", () => {
  const manifest = siteManifest(site)
  const siteWithGuide = { ...site, guideModule: site.modules[0] }
  assert.equal(manifest.start_url, "/docs/")
  assert.equal(manifest.icons[2].purpose, "maskable")
  assert.match(renderRobots(site), /Sitemap: https:\/\/docs\.example\.com\/docs\/sitemap\.xml/)
  assert.match(renderSitemap(site), /<loc>https:\/\/docs\.example\.com\/docs\/Machine\/<\/loc>/)
  assert.match(renderSitemap(site), /<loc>https:\/\/docs\.example\.com\/docs\/changelog\/<\/loc>/)
  assert.match(renderSitemap(siteWithGuide), /<loc>https:\/\/docs\.example\.com\/docs\/guide\/<\/loc>/)
})

test("accepts only pathless HTTPS production origins", () => {
  assert.equal(normalizeOrigin("https://docs.example.com"), "https://docs.example.com")
  assert.throws(() => normalizeOrigin("http://docs.example.com"), /HTTPS origin/)
  assert.throws(() => normalizeOrigin("https://docs.example.com/api"), /without a path/)
})
