import { readFileSync } from "node:fs"
import { Comment, CommentTag, MinimalSourceFile, ReflectionKind, normalizePath } from "typedoc"

/**
 * Attaches Effect-style leading module JSDoc to a TypeDoc module reflection.
 *
 * Effect uses an untagged leading comment while TypeDoc normally requires
 * `@module` or `@packageDocumentation`. Keeping the workaround here lets the
 * source remain compatible with Effect's JSDoc conventions.
 */
export const attachLeadingModuleComment = (app, project, sourcePath) => {
  const moduleReflection = project.children?.find((reflection) => reflection.kind === ReflectionKind.Module)
  if (moduleReflection === undefined || moduleReflection.comment !== undefined) return

  const source = readFileSync(sourcePath, "utf8")
  const match = /^\s*\/\*\*([\s\S]*?)\*\//.exec(source)
  if (match === null) return

  const parsed = splitJsDocComment(match[1] ?? "")
  if (parsed.summary.length === 0) return

  const parseMarkdown = (text) =>
    app.converter.parseRawComment(
      new MinimalSourceFile(text, normalizePath(sourcePath)),
      project.files
    ).content
  const comment = new Comment(
    parseMarkdown(parsed.summary),
    parsed.tags
      .filter(({ tag }) => tag !== "@module" && tag !== "@packageDocumentation")
      .map(({ tag, content }) => new CommentTag(tag, parseMarkdown(content)))
  )
  comment.sourcePath = normalizePath(sourcePath)
  moduleReflection.comment = comment
  app.converter.resolveLinks(comment, moduleReflection)
}

export const splitJsDocComment = (comment) => {
  const lines = comment
    .split("\n")
    .map((line) => line.replace(/^\s*\* ?/, "").replace(/\s+$/, ""))
  const summary = []
  const tags = []
  let currentTag
  let fenced = false

  for (const line of lines) {
    if (/^\s*```/.test(line)) fenced = !fenced
    const tagMatch = fenced ? null : /^\s*(@[a-zA-Z][\w-]*)(?:\s+(.*))?$/.exec(line)
    if (tagMatch !== null) {
      currentTag = { tag: tagMatch[1], lines: [tagMatch[2] ?? ""] }
      tags.push(currentTag)
    } else if (currentTag === undefined) {
      summary.push(line)
    } else {
      currentTag.lines.push(line)
    }
  }

  return {
    summary: summary.join("\n").trim(),
    tags: tags.map(({ tag, lines: content }) => ({
      tag,
      content: content.join("\n").trim()
    }))
  }
}
