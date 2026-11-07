import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, extname, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const root = resolve(import.meta.dirname, "../..")

const metadata = (path) => {
  const name = basename(path, extname(path))
  const fallback = name.replace(/^\d+/, "").replaceAll(/[-_]/g, " ").trim()
  const contents = readFileSync(path, "utf8")
  const start = contents.indexOf("/**")
  const end = contents.indexOf("*/", start)
  if (start === -1 || end === -1) {
    return { name, title: fallback.charAt(0).toUpperCase() + fallback.slice(1), content: contents.trim() }
  }
  let title = fallback.charAt(0).toUpperCase() + fallback.slice(1)
  const description = []
  for (const line of contents.slice(start, end).split("\n").slice(1)) {
    const text = line.replace(/^ \*\s?/, "").trimEnd()
    if (text.startsWith("@title")) title = text.replace("@title", "").trim()
    else description.push(text)
  }
  return {
    name,
    title,
    description: description.join("\n").trim() || undefined,
    content: contents.slice(end + 2).trim()
  }
}

const renderExample = (path, baseDirectory) => {
  const { content, description, name, title } = metadata(path)
  if (name.startsWith("0")) {
    return `#### ${title}\n\n${description === undefined ? "" : `${description}\n\n`}\`\`\`ts\n${content}\n\`\`\`\n`
  }
  const link = `[${title}](./${relative(baseDirectory, path).replaceAll("\\", "/")})`
  return `- **${link}**${description === undefined ? "" : `: ${description.replaceAll("\n", " ")}`}\n`
}

/** Renders a documentation directory depth first, in file name order. */
export const directoryToMarkdown = (directory, baseDirectory = directory) => {
  const entries = readdirSync(directory).sort()
  const parts = []
  if (entries.includes("index.md")) parts.push(readFileSync(join(directory, "index.md"), "utf8").trim())
  for (const entry of entries) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      if (entry !== "fixtures") parts.push(directoryToMarkdown(path, baseDirectory))
    } else if (/\.tsx?$/.test(entry)) {
      parts.push(renderExample(path, baseDirectory).trim())
    }
  }
  return parts.filter((part) => part.length > 0).join("\n\n")
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const output = join(root, "LLMS.md")
  const markdown = `${directoryToMarkdown(join(root, "ai-docs/src"), root)}\n`
  if (process.argv.includes("--check")) {
    if (readFileSync(output, "utf8") !== markdown) {
      throw new Error("LLMS.md is stale. Run `pnpm ai-docgen` and commit the result.")
    }
  } else {
    writeFileSync(output, markdown)
  }
}
