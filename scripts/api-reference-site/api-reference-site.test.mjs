import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  highlightCode,
  githubRepository,
  moduleRoute,
  normalizeBasePath,
  normalizeGitHubStars,
  normalizeOrigin,
  renderIndexPage,
  renderLayout,
  renderMarkdown,
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
  assert.equal(manifest.start_url, "/docs/")
  assert.equal(manifest.icons[2].purpose, "maskable")
  assert.match(renderRobots(site), /Sitemap: https:\/\/docs\.example\.com\/docs\/sitemap\.xml/)
  assert.match(renderSitemap(site), /<loc>https:\/\/docs\.example\.com\/docs\/Machine\/<\/loc>/)
})

test("accepts only pathless HTTPS production origins", () => {
  assert.equal(normalizeOrigin("https://docs.example.com"), "https://docs.example.com")
  assert.throws(() => normalizeOrigin("http://docs.example.com"), /HTTPS origin/)
  assert.throws(() => normalizeOrigin("https://docs.example.com/api"), /without a path/)
})
