import {
  cpSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { normalizeApiModule } from "../api-reference/normalize.mjs"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryDirectory = resolve(scriptDirectory, "../..")
const outputMarker = ".effect-api-reference-site"

export const generateApiReferenceSite = ({ check = false } = {}) => {
  const config = readConfig(join(repositoryDirectory, "api-reference-site.config.json"))
  const inputDirectory = resolve(repositoryDirectory, config.input)
  const configuredOutput = resolve(repositoryDirectory, config.output)
  const temporaryDirectory = check ? mkdtempSync(join(tmpdir(), "effect-machine-api-site-")) : undefined
  const outputDirectory = temporaryDirectory === undefined ? configuredOutput : join(temporaryDirectory, "site")

  try {
    const site = readSiteModel(inputDirectory, config)
    prepareOutputDirectory(outputDirectory)
    writeSite(outputDirectory, site)
    validateSite(outputDirectory, site)
    process.stdout.write(
      check
        ? `Validated API reference site (${site.modules.length} modules)\n`
        : `Generated API reference site in ${relative(repositoryDirectory, outputDirectory)}\n`
    )
  } finally {
    if (temporaryDirectory !== undefined) rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

const readSiteModel = (inputDirectory, config) => {
  const dataset = readJson(join(inputDirectory, "manifest.json"))
  if (dataset.datasetSchemaVersion !== 1 || !Array.isArray(dataset.packages) || dataset.packages.length !== 1) {
    throw new Error("The static site currently requires one API reference package")
  }

  const packageEntry = dataset.packages[0]
  const packageManifestPath = safeResolve(inputDirectory, packageEntry.manifest)
  const packageDirectory = dirname(packageManifestPath)
  const packageManifest = readJson(packageManifestPath)
  if (packageManifest.schemaVersion !== 4 || !Array.isArray(packageManifest.modules)) {
    throw new Error("Unsupported API reference package manifest")
  }

  const modules = packageManifest.modules.map((entry) => {
    const reflection = readJson(safeResolve(packageDirectory, entry.json))
    const api = normalizeApiModule(reflection)
    const route = moduleRoute(entry.json)
    const segments = entry.export.replace(/^\.\//, "").split("/")
    return {
      ...entry,
      api,
      route,
      label: segments.at(-1),
      navigationGroup: navigationGroup(segments)
    }
  })

  return {
    ...config,
    channel: dataset.channel,
    revision: dataset.revision,
    package: packageManifest,
    modules,
    navigation: groupNavigation(modules)
  }
}

const navigationGroup = (segments) => {
  if (segments[0] === "unstable") return "Unstable"
  if (segments.length === 1) return "Core"
  return titleCase(segments[0])
}

const groupNavigation = (modules) => {
  const groups = new Map()
  for (const module of modules) {
    groups.set(module.navigationGroup, [...groups.get(module.navigationGroup) ?? [], module])
  }
  return [...groups].map(([label, entries]) => ({ label, entries }))
}

const writeSite = (outputDirectory, site) => {
  writePage(join(outputDirectory, "index.html"), renderIndexPage(site))
  for (const module of site.modules) {
    writePage(join(outputDirectory, module.route, "index.html"), renderModulePage(site, module))
  }
  const assetDirectory = join(outputDirectory, "assets")
  mkdirSync(assetDirectory, { recursive: true })
  for (const asset of ["styles.css", "client.js"]) {
    copyFileSync(join(scriptDirectory, "assets", asset), join(assetDirectory, asset))
  }
  for (const entry of readdirSync(join(scriptDirectory, "public"))) {
    cpSync(join(scriptDirectory, "public", entry), join(outputDirectory, entry), { recursive: true })
  }
  writeJson(join(outputDirectory, "site.webmanifest"), siteManifest(site))
  writeFileSync(join(outputDirectory, "robots.txt"), renderRobots(site))
  writeFileSync(join(outputDirectory, "sitemap.xml"), renderSitemap(site))
}

export const renderIndexPage = (site) => {
  const moduleCards = site.modules.map((module) => `
    <a class="module-card" href="${siteUrl(site, module.route)}">
      <span class="module-card__path">${escapeHtml(displayExport(module.export))}</span>
      <strong>${escapeHtml(module.label)}</strong>
      <span>${escapeHtml(module.api.description ?? "API module")}</span>
      <small>${module.api.declarationCount} declarations</small>
    </a>`).join("")
  const content = `
    <section class="reference-hero" data-pagefind-meta="type:overview">
      <div class="eyebrow">API reference</div>
      <h1>${escapeHtml(site.package.name)}</h1>
      <p>${escapeHtml(site.package.description)}</p>
      <div class="hero-meta">
        <span>Version ${escapeHtml(site.package.version)}</span>
        <span>${site.modules.length} modules</span>
        <span>${site.modules.reduce((count, module) => count + module.api.declarationCount, 0)} declarations</span>
      </div>
    </section>
    <section class="module-grid" aria-labelledby="modules-title">
      <div class="section-heading">
        <h2 id="modules-title">Modules</h2>
        <p>Choose a module to explore its public declarations.</p>
      </div>
      <div class="module-cards">${moduleCards}</div>
    </section>`
  return renderLayout(site, {
    title: `${site.package.name} API reference`,
    content,
    currentRoute: "",
    pageKind: "overview"
  })
}

const renderModulePage = (site, module) => {
  const declarationIds = uniqueDeclarationIds(module.api.groups)
  const categoryLinks = module.api.groups.map((group) => `
    <a href="#${slugify(group.category)}">
      <span>${escapeHtml(titleCase(group.category))}</span>
      <small>${group.declarations.length}</small>
    </a>`).join("")
  const groups = module.api.groups.map((group) => `
    <section class="api-group" aria-labelledby="${slugify(group.category)}">
      <div class="api-group__heading">
        <h2 id="${slugify(group.category)}">${escapeHtml(titleCase(group.category))}</h2>
        <span>${group.declarations.length}</span>
      </div>
      ${group.declarations.map((declaration) =>
    renderDeclaration(declaration, declarationIds.get(declaration))).join("")}
    </section>`).join("")
  const content = `
    <article class="module-reference" data-pagefind-meta="module:${escapeAttribute(module.label)}">
      <header class="module-header">
        <div class="breadcrumbs">
          <a href="${siteUrl(site, "")}">API</a>
          <span aria-hidden="true">/</span>
          <span>${escapeHtml(displayExport(module.export))}</span>
        </div>
        <div class="module-title-row">
          <div>
            <div class="eyebrow">Module</div>
            <h1>${escapeHtml(module.label)}</h1>
          </div>
          ${module.api.sourceUrl === undefined ? "" : sourceLink(module.api.sourceUrl, "View source")}
        </div>
        ${renderMarkdown(module.api.description)}
        <div class="module-meta">
          ${module.api.since === undefined ? "" : `<span>Since v${escapeHtml(module.api.since)}</span>`}
          <span>${module.api.declarationCount} declarations</span>
          <code>${escapeHtml(module.export)}</code>
        </div>
      </header>
      ${groups}
    </article>`
  return renderLayout(site, {
    title: `${module.label} · ${site.title}`,
    description: module.api.description,
    content,
    currentRoute: module.route,
    pageKind: "module",
    toc: categoryLinks
  })
}

const renderDeclaration = (declaration, id) => {
  const examples = declaration.examples.map((example, index) => `
    <section class="example">
      <div class="example__heading">
        <strong>${escapeHtml(example.title ?? `Example${declaration.examples.length > 1 ? ` ${index + 1}` : ""}`)}</strong>
        <span>${escapeHtml(example.language)}</span>
      </div>
      <div class="code-block">
        <button class="copy-button" type="button" aria-label="Copy example code">Copy</button>
        <pre><code>${highlightCode(example.source, example.language)}</code></pre>
      </div>
    </section>`).join("")
  const see = declaration.see.flatMap((entry) => entry.split("\n"))
    .map((entry) => entry.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean)
  return `
    <article class="declaration" id="${id}" data-pagefind-meta="kind:${escapeAttribute(declaration.kind)}">
      <header class="declaration__header">
        <div class="declaration__title">
          <a class="anchor" href="#${id}" aria-label="Link to ${escapeAttribute(declaration.name)}">#</a>
          <h3>${escapeHtml(declaration.name)}</h3>
          <span class="kind kind--${slugify(declaration.kind)}">${escapeHtml(declaration.kind)}</span>
        </div>
        ${declaration.sourceUrl === undefined ? "" : sourceLink(declaration.sourceUrl, "Source")}
      </header>
      ${declaration.signature === undefined ? "" : `
        <div class="code-block code-block--signature">
          <button class="copy-button" type="button" aria-label="Copy ${escapeAttribute(declaration.name)} signature">Copy</button>
          <pre><code>${highlightCode(declaration.signature, "typescript")}</code></pre>
        </div>`}
      <div class="declaration__description">${renderMarkdown(declaration.description)}</div>
      ${declaration.deprecated === undefined ? "" : `
        <aside class="callout callout--deprecated">
          <strong>Deprecated</strong>
          ${renderMarkdown(declaration.deprecated)}
        </aside>`}
      ${examples}
      ${see.length === 0 ? "" : `
        <div class="see-also">
          <strong>See also</strong>
          <ul>${see.map((entry) => `<li>${renderInlineMarkdown(entry)}</li>`).join("")}</ul>
        </div>`}
      ${declaration.since === undefined ? "" : `<div class="since">Since v${escapeHtml(declaration.since)}</div>`}
    </article>`
}

export const renderLayout = (site, { content, currentRoute, description, pageKind, title, toc = "" }) => {
  const pageDescription = description ?? site.description
  const canonical = canonicalUrl(site, currentRoute)
  const socialImage = absoluteSiteUrl(site, site.socialImage)
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="description" content="${escapeAttribute(pageDescription)}">
    <meta name="theme-color" media="(prefers-color-scheme: light)" content="${escapeAttribute(site.themeColor.light)}">
    <meta name="theme-color" media="(prefers-color-scheme: dark)" content="${escapeAttribute(site.themeColor.dark)}">
    <meta name="api-reference-base" content="${escapeAttribute(site.basePath)}">
    <meta name="generator" content="effect-machine-api-reference-site">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="${escapeAttribute(site.title)}">
    <meta property="og:title" content="${escapeAttribute(title)}">
    <meta property="og:description" content="${escapeAttribute(pageDescription)}">
    <meta property="og:url" content="${escapeAttribute(canonical)}">
    <meta property="og:image" content="${escapeAttribute(socialImage)}">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:alt" content="${escapeAttribute(`${site.package.name} API reference`)}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapeAttribute(title)}">
    <meta name="twitter:description" content="${escapeAttribute(pageDescription)}">
    <meta name="twitter:image" content="${escapeAttribute(socialImage)}">
    <title>${escapeHtml(title)}</title>
    <link rel="canonical" href="${escapeAttribute(canonical)}">
    <link rel="icon" href="${siteUrl(site, "favicon.svg")}" type="image/svg+xml">
    <link rel="icon" href="${siteUrl(site, "favicon.ico")}" sizes="any">
    <link rel="apple-touch-icon" href="${siteUrl(site, "apple-touch-icon.png")}">
    <link rel="manifest" href="${siteUrl(site, "site.webmanifest")}">
    <script>document.documentElement.dataset.theme=localStorage.getItem("api-theme")||"auto"</script>
    <link rel="stylesheet" href="${siteUrl(site, "assets/styles.css")}">
    <script type="module" src="${siteUrl(site, "assets/client.js")}"></script>
  </head>
  <body data-page-kind="${pageKind}">
    ${renderHeader(site)}
    <div class="docs-shell">
      ${renderNavigation(site, currentRoute)}
      <main id="main-content" class="docs-main" data-pagefind-body>${content}</main>
      ${toc.length === 0 ? "" : `
        <aside class="page-toc" aria-label="On this page" data-pagefind-ignore>
          <strong>On this page</strong>
          <nav>${toc}</nav>
        </aside>`}
    </div>
    ${renderSearchDialog()}
  </body>
</html>
`
}

const renderHeader = (site) => {
  const repository = githubRepository(site.package.repositoryUrl)
  return `
  <a class="skip-link" href="#main-content">Skip to content</a>
  <header class="site-header" data-pagefind-ignore>
    <div class="site-header__brand">
      <button class="icon-button mobile-navigation-button" type="button" aria-label="Open navigation" aria-controls="module-navigation" aria-expanded="false">Menu</button>
      <a href="${siteUrl(site, "")}" aria-label="${escapeAttribute(site.package.name)} API reference home">
        <img class="brand-mark" src="${siteUrl(site, "logo.svg")}" alt="" width="28" height="28">
        <span class="brand-name">${escapeHtml(site.package.name)}</span>
      </a>
      <span class="version">v${escapeHtml(site.package.version.replace(/^v/, ""))}</span>
    </div>
    <div class="site-header__actions">
      <button class="search-button" type="button" data-open-search>
        <span>Search the API</span>
        <kbd>⌘ K</kbd>
      </button>
      <a class="header-link github-link" href="${escapeAttribute(site.package.repositoryUrl)}" aria-label="View ${escapeAttribute(repository)} on GitHub">
        <span class="github-link__label">GitHub</span>
        <span class="github-stars" data-github-stars="${escapeAttribute(repository)}" hidden>
          <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14"><path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.193a.75.75 0 0 1-1.088.79L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194-3.047-2.97a.75.75 0 0 1 .416-1.278l4.21-.612L7.327.668A.75.75 0 0 1 8 .25Z"/></svg>
          <span data-github-star-count></span>
        </span>
      </a>
      <button class="icon-button theme-button" type="button" aria-label="Change color theme" title="Change color theme">Theme</button>
    </div>
  </header>`
}

export const githubRepository = (value) => {
  const url = new URL(value)
  const segments = url.pathname.split("/").filter(Boolean)
  if (url.protocol !== "https:" || url.hostname !== "github.com" || segments.length !== 2) {
    throw new Error(`Expected a GitHub repository URL, received ${value}`)
  }
  return segments.join("/")
}

const renderNavigation = (site, currentRoute) => `
  <aside class="module-navigation" id="module-navigation" aria-label="API modules" data-pagefind-ignore>
    <div class="navigation-heading">
      <span>API reference</span>
      <button class="icon-button navigation-close" type="button" aria-label="Close navigation">Close</button>
    </div>
    <a class="navigation-overview${currentRoute === "" ? " is-current" : ""}" href="${siteUrl(site, "")}">Overview</a>
    ${site.navigation.map((group) => `
      <section>
        <h2>${escapeHtml(group.label)}</h2>
        <nav>
          ${group.entries.map((module) => `
            <a class="${module.route === currentRoute ? "is-current" : ""}" href="${siteUrl(site, module.route)}">
              <span>${escapeHtml(module.label)}</span>
              <small>${module.api.declarationCount}</small>
            </a>`).join("")}
        </nav>
      </section>`).join("")}
    <div class="navigation-footer">
      <span>${escapeHtml(site.package.name)}</span>
      <span>${escapeHtml(site.package.version)}</span>
    </div>
  </aside>
  <button class="navigation-backdrop" type="button" aria-label="Close navigation" tabindex="-1" data-pagefind-ignore></button>`

const renderSearchDialog = () => `
  <dialog class="search-dialog" data-search-dialog data-pagefind-ignore>
    <div class="search-dialog__header">
      <label for="api-search">Search API reference</label>
      <button class="icon-button" type="button" data-close-search aria-label="Close search">Esc</button>
    </div>
    <input id="api-search" type="search" autocomplete="off" placeholder="Search modules, functions, types…" data-search-input>
    <div class="search-status" role="status" aria-live="polite" data-search-status>Type at least two characters to search.</div>
    <ol class="search-results" data-search-results></ol>
  </dialog>`

export const renderMarkdown = (value) => {
  if (value === undefined || value.trim().length === 0) return ""
  return value.trim().split(/\n\s*\n/).map((block) => {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean)
    if (lines.length === 1 && /^\*\*[^*]+\*\*$/.test(lines[0])) {
      return `<h4 class="prose-heading">${renderInlineMarkdown(lines[0].slice(2, -2))}</h4>`
    }
    if (lines.every((line) => /^[-*]\s+/.test(line))) {
      return `<ul>${lines.map((line) => `<li>${renderInlineMarkdown(line.replace(/^[-*]\s+/, ""))}</li>`).join("")}</ul>`
    }
    return `<p>${renderInlineMarkdown(lines.join(" "))}</p>`
  }).join("")
}

const renderInlineMarkdown = (value) => escapeHtml(value)
  .replace(/`([^`]+)`/g, "<code>$1</code>")
  .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")

const typeScriptKeywords = new Set([
  "abstract",
  "as",
  "asserts",
  "async",
  "await",
  "class",
  "const",
  "declare",
  "else",
  "extends",
  "false",
  "function",
  "get",
  "if",
  "implements",
  "import",
  "in",
  "infer",
  "interface",
  "keyof",
  "let",
  "new",
  "null",
  "of",
  "readonly",
  "return",
  "satisfies",
  "set",
  "static",
  "true",
  "type",
  "typeof",
  "undefined",
  "unique",
  "unknown",
  "var",
  "void"
])

const typeScriptTypes = new Set([
  "any",
  "bigint",
  "boolean",
  "never",
  "number",
  "object",
  "string",
  "symbol"
])

export const highlightCode = (source, language) => {
  if (language !== "typescript" && language !== "javascript") return escapeHtml(source)
  const tokens = source.match(
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|[$_\p{L}][$\p{L}\p{N}_]*|\s+|./gu
  ) ?? []
  let previous
  return tokens.map((token) => {
    let kind
    if (/^\s+$/u.test(token)) kind = undefined
    else if (/^\/[/\*]/.test(token)) kind = "comment"
    else if (/^["'`]/.test(token)) kind = "string"
    else if (/^\d/.test(token)) kind = "number"
    else if (typeScriptKeywords.has(token)) kind = "keyword"
    else if (typeScriptTypes.has(token) || /^\p{Lu}/u.test(token)) kind = "type"
    else if (["class", "const", "function", "interface", "type"].includes(previous)) kind = "name"
    else if (/^[{}()[\]<>.,:;?=|&+\-*\/!]$/.test(token)) kind = "punctuation"
    if (!/^\s+$/u.test(token)) previous = token
    const escaped = escapeHtml(token)
    return kind === undefined ? escaped : `<span class="syntax-${kind}">${escaped}</span>`
  }).join("")
}

export const moduleRoute = (jsonPath) => {
  const withoutExtension = jsonPath.slice(0, -extname(jsonPath).length)
  if (
    withoutExtension.length === 0 ||
    withoutExtension.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Cannot derive a safe site route from ${JSON.stringify(jsonPath)}`)
  }
  return withoutExtension
}

export const uniqueDeclarationIds = (groups) => {
  const counts = new Map()
  const ids = new Map()
  for (const declaration of groups.flatMap((group) => group.declarations)) {
    const base = slugify(declaration.name)
    const count = (counts.get(base) ?? 0) + 1
    counts.set(base, count)
    ids.set(declaration, count === 1 ? base : `${base}-${count}`)
  }
  return ids
}

const siteUrl = (site, path) => `${site.basePath}${path}`.replace(/\/{2,}/g, "/")
const absoluteSiteUrl = (site, path) => new URL(siteUrl(site, path), `${site.origin}/`).href
const canonicalUrl = (site, route) => absoluteSiteUrl(site, route === "" ? "" : `${route}/`)

export const siteManifest = (site) => ({
  name: `${site.package.name} API reference`,
  short_name: "effect-machine",
  description: site.description,
  id: site.basePath,
  start_url: site.basePath,
  scope: site.basePath,
  display: "standalone",
  background_color: site.themeColor.light,
  theme_color: site.themeColor.light,
  icons: [
    { src: siteUrl(site, "icon-192.png"), sizes: "192x192", type: "image/png" },
    { src: siteUrl(site, "icon-512.png"), sizes: "512x512", type: "image/png" },
    { src: siteUrl(site, "icon-maskable-512.png"), sizes: "512x512", type: "image/png", purpose: "maskable" }
  ]
})

export const renderRobots = (site) => `User-agent: *
Allow: ${site.basePath}

Sitemap: ${absoluteSiteUrl(site, "sitemap.xml")}
`

export const renderSitemap = (site) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${["", ...site.modules.map((module) => `${module.route}/`)]
    .map((route) => `  <url><loc>${escapeXml(absoluteSiteUrl(site, route))}</loc></url>`)
    .join("\n")}
</urlset>
`
const displayExport = (value) => value === "." ? "root" : value.replace(/^\.\//, "")
const titleCase = (value) => value.replace(/(^|\s)(\p{L})/gu, (_, space, letter) => `${space}${letter.toUpperCase()}`)
const slugify = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "api"
const sourceLink = (url, label) =>
  `<a class="source-link" href="${escapeAttribute(url)}" target="_blank" rel="noreferrer">${label}<span aria-hidden="true">↗</span></a>`

const readConfig = (path) => {
  const config = readJson(path)
  if (typeof config.input !== "string" || typeof config.output !== "string") {
    throw new Error("API reference site input and output must be configured")
  }
  if (typeof config.title !== "string" || typeof config.description !== "string") {
    throw new Error("API reference site title and description must be configured")
  }
  if (
    typeof config.origin !== "string" ||
    typeof config.socialImage !== "string" ||
    typeof config.themeColor?.light !== "string" ||
    typeof config.themeColor?.dark !== "string"
  ) {
    throw new Error("API reference site origin, social image, and theme colors must be configured")
  }
  return {
    ...config,
    origin: normalizeOrigin(config.origin),
    basePath: normalizeBasePath(process.env.API_REFERENCE_BASE_PATH ?? config.basePath)
  }
}

export const normalizeOrigin = (value) => {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error("API reference site origin must be an absolute URL")
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("API reference site origin must be an HTTPS origin without a path")
  }
  return url.origin
}

export const normalizeBasePath = (value) => {
  if (typeof value !== "string" || (value.length > 0 && !value.startsWith("/"))) {
    throw new Error("API reference site basePath must be empty or start with a slash")
  }
  const segments = value.split("/").filter(Boolean)
  if (segments.some((part) => part === "." || part === ".." || !/^[a-z0-9._~-]+$/i.test(part))) {
    throw new Error(`Invalid API reference site basePath: ${JSON.stringify(value)}`)
  }
  return segments.length === 0 ? "/" : `/${segments.join("/")}/`
}

const prepareOutputDirectory = (path) => {
  assertSafeOutputDirectory(path)
  const status = statSync(path, { throwIfNoEntry: false })
  if (status !== undefined) {
    if (!status.isDirectory()) throw new Error(`Site output path is not a directory: ${path}`)
    if (!isFile(join(path, outputMarker)) && readdirSync(path).length > 0) {
      throw new Error(`Refusing to replace a site directory not created by this generator: ${path}`)
    }
    rmSync(path, { recursive: true })
  }
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, outputMarker), "")
}

const assertSafeOutputDirectory = (path) => {
  if (!isAbsolute(path) || path === resolve(path, sep) || path === repositoryDirectory) {
    throw new Error(`Refusing to replace unsafe site output directory: ${path}`)
  }
}

const validateSite = (outputDirectory, site) => {
  for (const path of [
    "index.html",
    "assets/styles.css",
    "assets/client.js",
    "apple-touch-icon.png",
    "favicon.ico",
    "favicon.svg",
    "icon-192.png",
    "icon-512.png",
    "icon-maskable-512.png",
    "logo.svg",
    "robots.txt",
    "site.webmanifest",
    "sitemap.xml",
    site.socialImage,
    ...site.modules.map((module) => join(module.route, "index.html"))
  ]) {
    if (!isFile(safeResolve(outputDirectory, path))) throw new Error(`Missing generated site file: ${path}`)
  }
}

const safeResolve = (base, path) => {
  const resolvedBase = resolve(base)
  const resolvedPath = resolve(resolvedBase, path)
  const relativePath = relative(resolvedBase, resolvedPath)
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`API reference site path escapes its dataset: ${path}`)
  }
  return resolvedPath
}

const writePage = (path, html) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, html)
}
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"))
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`)
const isFile = (path) => statSync(path, { throwIfNoEntry: false })?.isFile() === true
const escapeHtml = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;")
const escapeAttribute = escapeHtml
const escapeXml = escapeHtml

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    generateApiReferenceSite({ check: process.argv.includes("--check") })
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
