import { execFileSync } from "node:child_process"
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
  if (packageManifest.schemaVersion !== 6 || !Array.isArray(packageManifest.modules)) {
    throw new Error("Unsupported API reference package manifest")
  }

  const modules = packageManifest.modules.map((entry) => {
    const reflection = readJson(safeResolve(packageDirectory, entry.json))
    const api = normalizeApiModule(
      reflection,
      entry.usageSections ?? [],
      entry.referenceSections ?? []
    )
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
  const changelog = readChangelog(packageManifest.name)
  const agentGuide = readFileSync(join(repositoryDirectory, "docs", "agent-guide.md"), "utf8")

  return {
    ...config,
    channel: dataset.channel,
    revision: dataset.revision,
    package: packageManifest,
    modules,
    guideModule: modules.find((module) => (module.api.referenceSections ?? []).length > 0),
    navigation: groupNavigation(modules),
    changelog,
    agentGuide
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
  writePage(join(outputDirectory, "changelog", "index.html"), renderChangelogPage(site))
  writePage(join(outputDirectory, "agent-guide", "index.html"), renderAgentGuidePage(site))
  if (site.guideModule !== undefined) {
    writePage(join(outputDirectory, "guide", "index.html"), renderGuidePage(site))
  }
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

export const renderChangelogPage = (site) => {
  const releases = site.changelog ?? []
  const toc = releases.map((release) => `
    <a href="#release-${slugify(release.version)}">
      <span>${escapeHtml(release.version === "unreleased" ? "Unreleased" : `v${release.version}`)}</span>
      ${release.date === undefined ? "" : `<small>${escapeHtml(release.date)}</small>`}
    </a>`).join("")
  const content = `
    <article class="changelog" data-pagefind-meta="type:changelog">
      <header class="changelog-header">
        <div class="breadcrumbs">
          <a href="${siteUrl(site, "")}">API</a>
          <span aria-hidden="true">/</span>
          <span>Changelog</span>
        </div>
        <div class="eyebrow">Release history</div>
        <h1>Changelog</h1>
        <p>New features, improvements, and fixes from each release.</p>
      </header>
      ${releases.map(renderRelease).join("")}
    </article>`
  return renderLayout(site, {
    title: `Changelog · ${site.title}`,
    description: `Release history for ${site.package.name}`,
    content,
    currentRoute: "changelog",
    pageKind: "changelog",
    toc
  })
}

export const renderAgentGuidePage = (site) => {
  const resolveLink = (href) => href.startsWith("./") && href.endsWith(".md")
    ? `${site.package.repositoryUrl}/blob/main/docs/${href.slice(2)}`
    : href
  const content = `
    <article class="agent-guide" data-pagefind-meta="type:agent-guide">
      <div class="breadcrumbs">
        <a href="${siteUrl(site, "")}">API</a>
        <span aria-hidden="true">/</span>
        <span>Agent guide</span>
      </div>
      <div class="agent-guide__content">
        ${renderMarkdownDocument(site.agentGuide, { resolveLink })}
      </div>
    </article>`
  return renderLayout(site, {
    title: `Agent guide · ${site.title}`,
    description: "Statechart modeling patterns for agents working with Effect Machine.",
    content,
    currentRoute: "agent-guide",
    pageKind: "agent-guide",
    toc: renderDocumentToc(site.agentGuide)
  })
}

const renderRelease = (release) => `
  <section class="release" aria-labelledby="release-${slugify(release.version)}">
    <header class="release__header">
      <h2 id="release-${slugify(release.version)}">${
  escapeHtml(release.version === "unreleased" ? "Unreleased" : `v${release.version}`)
}</h2>
      ${release.date === undefined ? "" : `
        <time datetime="${escapeAttribute(release.date)}">${escapeHtml(formatReleaseDate(release.date))}</time>`}
    </header>
    ${release.groups.map((group) => `
      <section class="release-group">
        <h3>${escapeHtml(`${titleCase(group.type)} changes`)}</h3>
        <ul class="change-list">
          ${group.entries.map((entry) => `<li>${renderMarkdown(entry.description)}</li>`).join("")}
        </ul>
      </section>`).join("")}
  </section>`

export const renderModulePage = (site, module) => {
  const declarationIds = uniqueDeclarationIds(module.api.groups)
  const categoryLinks = module.api.groups.map((group) => `
    <details class="page-toc__group">
      <summary>
        <span>${escapeHtml(titleCase(group.category))}</span>
      <small>${group.declarations.length}</small>
    </summary>
    <nav aria-label="${escapeAttribute(titleCase(group.category))} APIs">
        ${group.declarations.map((declaration) => `
          <a href="#${declarationIds.get(declaration)}">${escapeHtml(declaration.name)}</a>`).join("")}
      </nav>
    </details>`).join("")
  const groups = module.api.groups.map((group) => `
    <section class="api-group" aria-labelledby="category-${slugify(group.category)}">
      <div class="api-group__heading">
        <h2 id="category-${slugify(group.category)}">${escapeHtml(titleCase(group.category))}</h2>
        <span>${group.declarations.length}</span>
      </div>
      ${group.declarations.map((declaration) =>
    renderDeclaration(
      {
        ...declaration,
        usageSections: []
      },
      declarationIds.get(declaration)
    )).join("")}
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

export const renderGuidePage = (site) => {
  const module = site.guideModule
  if (module === undefined) throw new Error("The guide reference requires a configured guide module")
  const declarationIds = uniqueDeclarationIds(module.api.groups)
  const entryIds = referenceIds(module.api.referenceSections, declarationIds)
  const entryCount = module.api.referenceSections.reduce((count, section) => count + section.entries.length, 0)
  const content = `
    <article class="guide-reference" data-pagefind-meta="type:guide">
      <header class="guide-header">
        <div class="breadcrumbs">
          <a href="${siteUrl(site, "")}">API</a>
          <span aria-hidden="true">/</span>
          <span>Guide reference</span>
        </div>
        <h1>Machine authoring guide</h1>
        <p>The core APIs and nested parameters used to define, implement, and run a machine, organized in authoring order.</p>
        <div class="module-meta">
          <span>${module.api.referenceSections.length} sections</span>
          <span>${entryCount} core APIs</span>
          <code>${escapeHtml(module.export)}</code>
        </div>
      </header>
      <div class="guide-sections">
        ${module.api.referenceSections.map((section) => `
          <section class="workflow-section" aria-labelledby="workflow-${slugify(section.title)}">
            <header class="workflow-section__header">
              <h2 id="workflow-${slugify(section.title)}">${escapeHtml(section.title)}</h2>
              ${renderMarkdown(section.description)}
            </header>
            <div class="workflow-section__entries">
              ${section.entries.map((entry) =>
    renderDeclaration(entry.api, entryIds.get(entry), { core: true })).join("")}
            </div>
          </section>`).join("")}
      </div>
    </article>`
  return renderLayout(site, {
    title: `Machine authoring guide · ${site.title}`,
    description: "Core Effect Machine APIs and nested authoring parameters in usage order.",
    content,
    currentRoute: "guide",
    pageKind: "guide",
    toc: renderGuideToc(module.api.referenceSections, entryIds)
  })
}

const referenceIds = (sections, declarationIds) => {
  const ids = new Map()
  const used = new Set(declarationIds.values())
  for (const section of sections) {
    for (const entry of section.entries) {
      if (entry.origin.type === "declaration") {
        ids.set(entry, declarationIds.get(entry.api))
        continue
      }
      const base = slugify(entry.api.name)
      let id = base
      for (let suffix = 2; used.has(id); suffix++) id = `${base}-${suffix}`
      used.add(id)
      ids.set(entry, id)
    }
  }
  return ids
}

const renderDeclaration = (
  declaration,
  id,
  { core = false, headingLevel = 3, usageHeadingLevel = 4 } = {}
) => {
  const examples = renderExamples(declaration.examples)
  const usageSections = (declaration.usageSections ?? [])
    .map((section) => renderUsageSection(section, id, usageHeadingLevel))
    .join("")
  const see = declaration.see.flatMap((entry) => entry.split("\n"))
    .map((entry) => entry.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean)
  return `
    <article class="declaration${core ? " declaration--core" : ""}" aria-labelledby="${id}" data-pagefind-meta="kind:${escapeAttribute(declaration.kind)}">
      <header class="declaration__header">
        <div class="declaration__title">
          <a class="anchor" href="#${id}" aria-label="Link to ${escapeAttribute(declaration.name)}">#</a>
          <h${headingLevel} id="${id}">${escapeHtml(declaration.name)}</h${headingLevel}>
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
      ${usageSections}
      ${see.length === 0 ? "" : `
        <div class="see-also">
          <strong>See also</strong>
          <ul>${see.map((entry) => `<li>${renderInlineMarkdown(entry)}</li>`).join("")}</ul>
        </div>`}
      ${declaration.since === undefined ? "" : `<div class="since">Since v${escapeHtml(declaration.since)}</div>`}
    </article>`
}

const renderExamples = (examples) => examples.map((example, index) => `
    <section class="example">
      <div class="example__heading">
        <strong>${escapeHtml(example.title ?? `Example${examples.length > 1 ? ` ${index + 1}` : ""}`)}</strong>
        <span>${escapeHtml(example.language)}</span>
      </div>
      <div class="code-block">
        <button class="copy-button" type="button" aria-label="Copy example code">Copy</button>
        <pre><code>${highlightCode(example.source, example.language)}</code></pre>
      </div>
    </section>`).join("")

const usageSectionId = (declarationId, section) => `${declarationId}-usage-${slugify(section.title)}`
const usageRootId = (sectionId, root) => `${sectionId}-${slugify(root.label)}`
const usageMemberId = (parentId, member) => `${parentId}-${slugify(member.name)}`

const renderUsageSection = (section, declarationId, headingLevel = 4) => {
  const id = usageSectionId(declarationId, section)
  return `
    <div class="usage-section" id="${id}" data-pagefind-meta="type:configuration">
      <div class="usage-roots">
        ${section.roots.map((root) => renderUsageRoot(root, id, headingLevel)).join("")}
      </div>
    </div>`
}

const renderUsageRoot = (root, sectionId, headingLevel = 5) => {
  const id = usageRootId(sectionId, root)
  return `
    <section class="usage-root" aria-labelledby="${id}">
      <header class="usage-root__header">
        <h${Math.min(headingLevel, 6)} id="${id}">${escapeHtml(root.label)}</h${Math.min(headingLevel, 6)}>
        ${root.sourceUrl === undefined ? "" : sourceLink(root.sourceUrl, "Source")}
      </header>
      <div class="usage-root__description">${renderMarkdown(root.description)}</div>
      ${renderExamples(root.examples ?? [])}
      <div class="usage-members">
        ${root.members.map((member) => renderUsageMember(member, 0, id, headingLevel + 1)).join("")}
      </div>
    </section>`
}

const renderUsageMember = (member, depth, parentId, headingLevel) => {
  const hasSignature = member.signature !== undefined && member.signature.length > 0
  const id = usageMemberId(parentId, member)
  const titleId = `${id}-title`
  const titleLevel = Math.min(headingLevel, 6)
  return `
  <article class="usage-member usage-member--depth-${Math.min(depth, 2)}" id="${id}" aria-labelledby="${titleId}" data-pagefind-meta="parameter:${escapeAttribute(member.name)}">
    <header class="usage-member__header">
      <h${titleLevel} id="${titleId}">${escapeHtml(member.name)}</h${titleLevel}>
      ${member.sourceUrl === undefined ? "" : sourceLink(member.sourceUrl, "Source")}
    </header>
    ${hasSignature ? `
      <div class="code-block code-block--usage-signature">
        <button class="copy-button" type="button" aria-label="Copy ${escapeAttribute(member.name)} signature">Copy</button>
        <pre><code>${highlightCode(member.signature, "typescript")}</code></pre>
      </div>` : ""}
    <div class="usage-member__description">${renderMarkdown(member.description)}</div>
    ${member.defaultValue === undefined ? "" : `
      <div class="usage-member__default"><strong>Default</strong> ${renderInlineMarkdown(member.defaultValue)}</div>`}
    ${member.deprecated === undefined ? "" : `
      <aside class="callout callout--deprecated"><strong>Deprecated</strong>${renderMarkdown(member.deprecated)}</aside>`}
    ${renderExamples(member.examples ?? [])}
    ${member.parameters.length === 0 ? "" : `
      <dl class="usage-parameters">
        ${member.parameters.map((parameter) => `
          <div><dt><code>${escapeHtml(parameter.signature)}</code></dt><dd>${renderMarkdown(parameter.description)}</dd></div>`).join("")}
      </dl>`}
    ${member.members.length === 0 ? "" : `
      <div class="usage-members usage-members--nested">
        ${member.members.map((child) => renderUsageMember(child, depth + 1, id, titleLevel + 1)).join("")}
      </div>`}
    ${member.since === undefined ? "" : `<div class="since">Since v${escapeHtml(member.since)}</div>`}
  </article>`
}

const renderGuideToc = (sections, entryIds) => sections.map((section) => `
  <section class="guide-toc-section">
    <a class="guide-toc-section__link" href="#workflow-${slugify(section.title)}">${escapeHtml(section.title)}</a>
    <div class="guide-toc-section__entries">
      ${section.entries.map((entry) => {
  const declarationId = entryIds.get(entry)
  return `
        <div class="guide-toc-entry">
          <a class="guide-toc-entry__link" href="#${declarationId}">${escapeHtml(entry.api.name)}</a>
          ${(entry.api.usageSections ?? []).map((usageSection) => {
    const sectionId = usageSectionId(declarationId, usageSection)
    return usageSection.roots.map((root) => {
      const rootId = usageRootId(sectionId, root)
      return `
                <div class="guide-toc-root">
                  <a class="guide-toc-root__link" href="#${rootId}">${escapeHtml(root.label)}</a>
                  ${renderGuideMemberLinks(root.members, rootId, 0)}
                </div>`
    }).join("")
  }).join("")}
        </div>`
}).join("")}
    </div>
  </section>`).join("")

const renderGuideMemberLinks = (members, parentId, depth) => members.map((member) => {
  const id = usageMemberId(parentId, member)
  return `
    <a class="guide-toc-member guide-toc-member--depth-${Math.min(depth, 2)}" href="#${id}">${escapeHtml(member.name)}</a>
    ${renderGuideMemberLinks(member.members, id, depth + 1)}`
}).join("")

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
  const stars = renderGitHubStars(site.githubStars)
  const githubLabel = stars === ""
    ? `View ${repository} on GitHub`
    : `View ${repository} on GitHub (${githubStarsLabel(site.githubStars)})`
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
      <a class="header-link github-link" href="${escapeAttribute(site.package.repositoryUrl)}" aria-label="${escapeAttribute(githubLabel)}">
        <span class="github-link__label">GitHub</span>
        ${stars}
      </a>
      <button class="icon-button theme-button" type="button" aria-label="Change color theme" title="Change color theme">Theme</button>
    </div>
  </header>`
}

const renderGitHubStars = (count) => count === undefined ? "" : `
        <span class="github-stars" title="${escapeAttribute(githubStarsLabel(count))}">
          <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14"><path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.193a.75.75 0 0 1-1.088.79L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194-3.047-2.97a.75.75 0 0 1 .416-1.278l4.21-.612L7.327.668A.75.75 0 0 1 8 .25Z"/></svg>
          <span>${new Intl.NumberFormat("en-US").format(count)}</span>
        </span>`

const githubStarsLabel = (count) =>
  `${new Intl.NumberFormat("en-US").format(count)} GitHub star${count === 1 ? "" : "s"}`

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
    <a class="navigation-changelog${currentRoute === "changelog" ? " is-current" : ""}" href="${siteUrl(site, "changelog")}">Changelog</a>
    <a class="navigation-agent-guide${currentRoute === "agent-guide" ? " is-current" : ""}" href="${siteUrl(site, "agent-guide")}">Agent guide</a>
    ${site.guideModule === undefined ? "" : `
      <a class="navigation-guide${currentRoute === "guide" ? " is-current" : ""}" href="${siteUrl(site, "guide")}">Machine API</a>`}
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
  const lines = value.trim().replaceAll("\r\n", "\n").split("\n")
  const output = []
  const prose = []
  const flushProse = () => {
    if (prose.length === 0) return
    output.push(renderProseMarkdown(prose.join("\n")))
    prose.length = 0
  }
  for (let index = 0; index < lines.length; index++) {
    const fence = /^\s*```([^`]*)\s*$/u.exec(lines[index])
    if (fence === null) {
      prose.push(lines[index])
      continue
    }
    flushProse()
    const source = []
    for (index += 1; index < lines.length && !/^\s*```\s*$/u.test(lines[index]); index++) {
      source.push(lines[index])
    }
    output.push(renderMarkdownCodeBlock(source.join("\n"), fence[1].trim()))
  }
  flushProse()
  return output.join("")
}

export const renderMarkdownDocument = (value, { resolveLink = (href) => href } = {}) => {
  if (value === undefined || value.trim().length === 0) return ""
  const lines = value.trim().replaceAll("\r\n", "\n").split("\n")
  const output = []
  const prose = []
  const flushProse = () => {
    if (prose.length === 0) return
    output.push(renderDocumentProseMarkdown(prose.join("\n"), resolveLink))
    prose.length = 0
  }
  for (let index = 0; index < lines.length; index++) {
    const fence = /^\s*```([^`]*)\s*$/u.exec(lines[index])
    if (fence === null) {
      prose.push(lines[index])
      continue
    }
    flushProse()
    const source = []
    for (index += 1; index < lines.length && !/^\s*```\s*$/u.test(lines[index]); index++) {
      source.push(lines[index])
    }
    output.push(renderMarkdownCodeBlock(source.join("\n"), fence[1].trim()))
  }
  flushProse()
  return output.join("")
}

const renderDocumentProseMarkdown = (value, resolveLink) => {
  if (value.trim().length === 0) return ""
  return value.trim().split(/\n\s*\n/).map((block) => {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean)
    const heading = lines.length === 1 ? /^(#{1,6})\s+(.+)$/u.exec(lines[0]) : undefined
    if (heading !== undefined && heading !== null) {
      const level = heading[1].length
      return `<h${level} id="${slugify(heading[2])}">${renderDocumentInlineMarkdown(heading[2], resolveLink)}</h${level}>`
    }
    if (/^[-*]\s+/.test(lines[0])) return renderDocumentList(lines, /^[-*]\s+/, "ul", resolveLink)
    if (/^\d+\.\s+/.test(lines[0])) return renderDocumentList(lines, /^\d+\.\s+/, "ol", resolveLink)
    return `<p>${renderDocumentInlineMarkdown(lines.join(" "), resolveLink)}</p>`
  }).join("")
}

const renderDocumentList = (lines, marker, tag, resolveLink) => {
  const items = []
  for (const line of lines) {
    if (marker.test(line)) items.push(line.replace(marker, ""))
    else if (items.length > 0) items[items.length - 1] += ` ${line}`
  }
  return `<${tag}>${items.map((item) =>
    `<li>${renderDocumentInlineMarkdown(item, resolveLink)}</li>`).join("")}</${tag}>`
}

const renderDocumentInlineMarkdown = (value, resolveLink) => {
  const links = []
  const tokenized = value.replace(/\[([^\]]+)]\(([^)]+)\)/g, (_, label, href) => {
    const token = `@@DOCUMENT_LINK_${links.length}@@`
    links.push({ token, label, href })
    return token
  })
  let rendered = renderInlineMarkdown(tokenized)
  for (const link of links) {
    rendered = rendered.replaceAll(
      link.token,
      `<a href="${escapeAttribute(resolveLink(link.href))}">${renderInlineMarkdown(link.label)}</a>`
    )
  }
  return rendered
}

const renderDocumentToc = (markdown) => [...markdown.matchAll(/^##\s+(.+)$/gmu)]
  .map((heading) =>
    `<a href="#${slugify(heading[1])}">${renderInlineMarkdown(heading[1])}</a>`
  )
  .join("")

const renderProseMarkdown = (value) => {
  if (value.trim().length === 0) return ""
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

const renderMarkdownCodeBlock = (source, language) => {
  const normalizedLanguage = ({ js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript" })[
    language.toLowerCase()
  ] ?? language.toLowerCase()
  const label = language.length === 0 ? "code" : `${language} code`
  return `
    <div class="code-block code-block--markdown">
      <button class="copy-button" type="button" aria-label="Copy ${escapeAttribute(label)}">Copy</button>
      <pre><code>${highlightCode(source, normalizedLanguage)}</code></pre>
    </div>`
}

export const parseChangelog = (markdown, releaseDates = new Map()) => {
  const headings = [...markdown.matchAll(/^##\s+([^\n]+)\s*$/gm)]
  return headings.map((heading, index) => {
    const version = heading[1].trim().replace(/^v/, "")
    const start = heading.index + heading[0].length
    const end = headings[index + 1]?.index ?? markdown.length
    return {
      version,
      date: releaseDates.get(version),
      groups: parseChangeGroups(markdown.slice(start, end))
    }
  }).filter((release) => release.groups.length > 0)
}

export const parseChangeset = (markdown, packageName) => {
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]+)$/u.exec(markdown.trim())
  if (match === null) return undefined
  const escapedPackage = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const bump = new RegExp(`^\\s*["']?${escapedPackage}["']?\\s*:\\s*(major|minor|patch)\\s*$`, "mu")
    .exec(match[1])?.[1]
  const description = match[2].trim()
  return bump === undefined || description.length === 0 ? undefined : { type: bump, description }
}

const parseChangeGroups = (markdown) => {
  const groups = []
  let group
  let entry
  const finishEntry = () => {
    if (entry === undefined || group === undefined) return
    const description = entry.join("\n").trim()
    if (description.length > 0) group.entries.push({ description })
    entry = undefined
  }
  for (const line of markdown.split("\n")) {
    const heading = /^###\s+(Major|Minor|Patch) Changes\s*$/iu.exec(line)
    if (heading !== null) {
      finishEntry()
      group = { type: heading[1].toLowerCase(), entries: [] }
      groups.push(group)
      continue
    }
    const bullet = /^-\s+(?:[0-9a-f]+:\s+)?(.*)$/iu.exec(line)
    if (bullet !== null && group !== undefined) {
      finishEntry()
      entry = [bullet[1]]
      continue
    }
    if (entry !== undefined) entry.push(line.replace(/^ {2}/, ""))
  }
  finishEntry()
  return groups.filter((candidate) => candidate.entries.length > 0)
}

const readChangelog = (packageName) => {
  const releases = parseChangelog(
    readFileSync(join(repositoryDirectory, "CHANGELOG.md"), "utf8"),
    readReleaseDates(packageName)
  )
  const pending = readdirSync(join(repositoryDirectory, ".changeset"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md")
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => parseChangeset(
      readFileSync(join(repositoryDirectory, ".changeset", entry.name), "utf8"),
      packageName
    ))
    .filter((entry) => entry !== undefined)
  if (pending.length === 0) return releases
  const grouped = new Map()
  for (const entry of pending) grouped.set(entry.type, [...grouped.get(entry.type) ?? [], entry])
  return [{
    version: "unreleased",
    groups: ["major", "minor", "patch"]
      .filter((type) => grouped.has(type))
      .map((type) => ({ type, entries: grouped.get(type) }))
  }, ...releases]
}

const readReleaseDates = (packageName) => {
  let output
  try {
    output = execFileSync(
      "git",
      ["for-each-ref", "--format=%(refname:strip=2)\t%(creatordate:short)", "refs/tags"],
      { cwd: repositoryDirectory, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    )
  } catch {
    return new Map()
  }
  const prefix = `${packageName}@`
  return new Map(output.trim().split("\n").flatMap((line) => {
    const [tag, date] = line.split("\t")
    return tag?.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}$/.test(date ?? "")
      ? [[tag.slice(prefix.length).replace(/^v/, ""), date]]
      : []
  }))
}

const formatReleaseDate = (value) => {
  const [year, month, day] = value.split("-").map(Number)
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ]
  return `${months[month - 1]} ${day}, ${year}`
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
${["", "changelog/", "agent-guide/", ...(site.guideModule === undefined ? [] : ["guide/"]), ...site.modules.map((module) => `${module.route}/`)]
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
    basePath: normalizeBasePath(process.env.API_REFERENCE_BASE_PATH ?? config.basePath),
    githubStars: normalizeGitHubStars(process.env.API_REFERENCE_GITHUB_STARS)
  }
}

export const normalizeGitHubStars = (value) => {
  if (value === undefined || value === "") return undefined
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error("API_REFERENCE_GITHUB_STARS must be a non-negative integer")
  }
  const count = Number(value)
  if (!Number.isSafeInteger(count)) {
    throw new Error("API_REFERENCE_GITHUB_STARS exceeds the safe integer range")
  }
  return count
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
    "changelog/index.html",
    "agent-guide/index.html",
    ...(site.guideModule === undefined ? [] : ["guide/index.html"]),
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
