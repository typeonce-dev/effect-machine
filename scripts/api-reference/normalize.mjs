import { ReflectionKind } from "typedoc"

/**
 * Converts a TypeDoc project reflection into the stable view a website needs.
 * Raw TypeDoc JSON remains the generated artifact; this adapter isolates a
 * future site from TypeDoc's complete reflection schema.
 */
export const normalizeApiModule = (reflection) => {
  const moduleReflection = reflection.children?.find((child) => child.children !== undefined)
  const declarations = (moduleReflection?.children ?? []).map(normalizeDeclaration)
  const groups = groupBy(declarations, (declaration) => declaration.category)
  const versions = declarations.flatMap((declaration) => declaration.since === undefined ? [] : [declaration.since])

  return {
    name: moduleReflection?.name ?? reflection.name,
    description: commentMarkdown(moduleReflection?.comment),
    since: versions.toSorted(compareVersions)[0],
    sourceUrl: declarations.find((declaration) => declaration.sourceUrl !== undefined)?.sourceUrl,
    declarationCount: declarations.length,
    groups: [...groups]
      .map(([category, groupedDeclarations]) => ({
        category,
        declarations: groupedDeclarations.toSorted((left, right) =>
          left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind)
        )
      }))
      .toSorted((left, right) => left.category.localeCompare(right.category))
  }
}

/**
 * Enforces the documentation contract for declarations rendered by the static
 * reference. Example requirements stay explicit because not every public type
 * or low-level utility benefits from an example.
 */
export const validateApiDocumentation = (moduleExport, api, requiredExamples = []) => {
  const declarations = api.groups.flatMap((group) => group.declarations)
  const violations = []

  for (const declaration of declarations) {
    if (declaration.description === undefined) violations.push(`${declaration.name}: missing summary`)
    if (declaration.category === "Other") violations.push(`${declaration.name}: missing @category`)
    if (declaration.since === undefined) {
      violations.push(`${declaration.name}: missing @since`)
    } else if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(declaration.since)) {
      violations.push(`${declaration.name}: invalid @since ${JSON.stringify(declaration.since)}`)
    }
  }

  const declarationsByName = new Map(declarations.map((declaration) => [declaration.name, declaration]))
  for (const name of requiredExamples) {
    const declaration = declarationsByName.get(name)
    if (declaration === undefined) {
      violations.push(`${name}: configured example requirement does not match a declaration`)
    } else if (declaration.examples.length === 0) {
      violations.push(`${name}: missing example`)
    }
  }

  if (violations.length > 0) {
    throw new Error(`Incomplete API documentation for ${moduleExport}:\n- ${violations.join("\n- ")}`)
  }
}

const groupBy = (values, keyOf) => {
  const groups = new Map()
  for (const value of values) {
    const key = keyOf(value)
    groups.set(key, [...groups.get(key) ?? [], value])
  }
  return groups
}

const normalizeDeclaration = (declaration) => {
  const comment = declarationComment(declaration)
  return {
    name: declaration.name,
    kind: reflectionKindName(declaration.kind),
    category: blockTagText(comment?.blockTags, "@category") ?? "Other",
    signature: declarationSignature(declaration),
    description: commentMarkdown(comment),
    since: blockTagText(comment?.blockTags, "@since"),
    deprecated: blockTagText(comment?.blockTags, "@deprecated"),
    see: blockTagTexts(comment?.blockTags, "@see"),
    examples: codeExamples(declaration),
    sourceUrl: firstSourceUrl(declaration.sources)
  }
}

const declarationComment = (declaration) =>
  declaration.comment ?? declaration.signatures?.find((signature) => signature.comment !== undefined)?.comment

const commentMarkdown = (comment) => {
  if (comment === undefined) return undefined
  const markdown = commentPartsMarkdown(comment.summary)
  const withoutExample = markdown.replace(/\n\n\*\*Example\*\*[\s\S]*$/, "").trim()
  return withoutExample.length === 0 ? undefined : withoutExample
}

const commentPartsMarkdown = (parts = []) =>
  parts
    .flatMap((part) => {
      if (part.kind === "code" && parseFencedCode(part.text) !== undefined) return []
      if (part.kind === "inline-tag") return [part.tsLinkText ?? part.text]
      return [part.text]
    })
    .join("")

const blockTagText = (tags, name) => blockTagTexts(tags, name)[0]

const blockTagTexts = (tags, name) =>
  (tags ?? [])
    .filter((tag) => tag.tag === name)
    .map((tag) => commentPartsMarkdown(tag.content).trim())
    .filter(Boolean)

const codeExamples = (reflection) => {
  const examples = []
  visitReflection(reflection, examples)
  return examples
}

const visitReflection = (reflection, examples) => {
  const comment = reflection.comment
  if (comment !== undefined) {
    const since = blockTagText(comment.blockTags, "@since")
    for (let index = 0; index < comment.summary.length; index++) {
      const part = comment.summary[index]
      if (part?.kind !== "code") continue
      const fenced = parseFencedCode(part.text)
      if (fenced === undefined) continue
      examples.push({
        ...fenced,
        title: exampleTitle(comment.summary.slice(0, index)),
        since,
        sourceUrl: firstSourceUrl(reflection.sources)
      })
    }
    for (const tag of comment.blockTags ?? []) {
      if (tag.tag !== "@example") continue
      for (const part of tag.content) {
        if (part.kind !== "code") continue
        const fenced = parseFencedCode(part.text)
        if (fenced !== undefined) {
          examples.push({ ...fenced, since, sourceUrl: firstSourceUrl(reflection.sources) })
        }
      }
    }
  }
  for (const child of reflectionChildren(reflection)) visitReflection(child, examples)
}

const reflectionChildren = (reflection) => [
  ...("children" in reflection ? reflection.children ?? [] : []),
  ...("signatures" in reflection ? reflection.signatures ?? [] : []),
  ...("indexSignatures" in reflection ? reflection.indexSignatures ?? [] : []),
  ...("parameters" in reflection ? reflection.parameters ?? [] : []),
  ...("typeParameters" in reflection ? reflection.typeParameters ?? [] : []),
  ...("getSignature" in reflection && reflection.getSignature !== undefined ? [reflection.getSignature] : []),
  ...("setSignature" in reflection && reflection.setSignature !== undefined ? [reflection.setSignature] : [])
]

const parseFencedCode = (value) => {
  const match = /^```([^\n]*)\n([\s\S]*?)\n```\s*$/.exec(value)
  if (match === null) return undefined
  const language = normalizeLanguage((match[1] ?? "").trim().split(/\s+/)[0] ?? "")
  const source = match[2]
  return language === undefined || source === undefined ? undefined : { language, source }
}

const normalizeLanguage = (language) => {
  switch (language) {
    case "bash":
    case "json":
      return language
    case "js":
    case "javascript":
      return "javascript"
    case "":
    case "ts":
    case "typescript":
      return "typescript"
    default:
      return undefined
  }
}

const exampleTitle = (parts) => {
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index]
    if (part?.kind !== "text") continue
    const match = /\*\*Example\*\*(?:\s*\(([^)]+)\))?[^]*$/.exec(part.text)
    if (match !== null) return match[1]
  }
  return undefined
}

const declarationSignature = (declaration) => {
  const typeParameters = formatTypeParameters(declaration.typeParameters)
  switch (declaration.kind) {
    case ReflectionKind.Function:
      return declaration.signatures
        ?.map((signature) => `declare function ${declaration.name}${formatDeclarationSignature(signature)}`)
        .join("\n")
    case ReflectionKind.Variable:
      return declaration.type === undefined ? undefined : `declare const ${declaration.name}: ${formatType(declaration.type)}`
    case ReflectionKind.Interface:
      return `interface ${declaration.name}${typeParameters}${formatHeritageClause("extends", declaration.extendedTypes)} ${formatObjectBody(declaration)}`
    case ReflectionKind.Class:
      return `declare class ${declaration.name}${typeParameters}${formatHeritageClause("extends", declaration.extendedTypes)}${formatHeritageClause("implements", declaration.implementedTypes)} ${formatObjectBody(declaration)}`
    case ReflectionKind.TypeAlias:
      return `type ${declaration.name}${typeParameters} = ${declaration.type === undefined ? formatObjectBody(declaration) : formatType(declaration.type)}`
    default:
      return undefined
  }
}

const formatDeclarationSignature = (signature) => `${formatSignatureHead(signature)}: ${formatType(signature.type)}`

const formatFunctionType = (signature) => `${formatSignatureHead(signature)} => ${formatType(signature.type)}`

const formatSignatureHead = (signature) =>
  `${formatTypeParameters(signature.typeParameters)}(${(signature.parameters ?? []).map(formatParameter).join(", ")})`

const formatParameter = (parameter) => {
  const rest = parameter.flags?.isRest === true ? "..." : ""
  const optional = parameter.flags?.isOptional === true && rest.length === 0 ? "?" : ""
  return `${rest}${parameter.name}${optional}: ${formatType(parameter.type)}`
}

const formatTypeParameters = (parameters) =>
  parameters === undefined || parameters.length === 0
    ? ""
    : `<${parameters.map((parameter) => {
      const variance = parameter.varianceModifier === undefined ? "" : `${parameter.varianceModifier} `
      const constraint = parameter.type === undefined ? "" : ` extends ${formatType(parameter.type)}`
      const defaultType = parameter.default === undefined ? "" : ` = ${formatType(parameter.default)}`
      return `${variance}${parameter.name}${constraint}${defaultType}`
    }).join(", ")}>`

const formatHeritageClause = (keyword, types) =>
  types === undefined || types.length === 0 ? "" : ` ${keyword} ${types.map(formatType).join(", ")}`

const formatObjectBody = (declaration, depth = 0) => {
  if (depth > 12) return "{}"
  const members = [
    ...(declaration.signatures ?? []).map((signature) => `${formatDeclarationSignature(signature)};`),
    ...(declaration.indexSignatures ?? []).map((signature) =>
      `[${(signature.parameters ?? []).map(formatParameter).join(", ")}]: ${formatType(signature.type)};`
    ),
    ...(declaration.children ?? []).flatMap((member) => formatMember(member, depth))
  ]
  return members.length === 0 ? "{}" : `{\n${members.map((member) => indent(member)).join("\n")}\n}`
}

const formatMember = (member, depth) => {
  const optional = member.flags?.isOptional === true ? "?" : ""
  const readonly = member.flags?.isReadonly === true ? "readonly " : ""
  switch (member.kind) {
    case ReflectionKind.Constructor:
      return (member.signatures ?? []).map((signature) => `constructor${formatSignatureHead(signature)};`)
    case ReflectionKind.Method:
      return (member.signatures ?? []).map((signature) =>
        `${member.name}${optional}${formatDeclarationSignature(signature)};`
      )
    default:
      return member.type === undefined
        ? []
        : [`${readonly}${member.name}${optional}: ${formatType(member.type, depth + 1)};`]
  }
}

const formatType = (value, depth = 0) => {
  if (value === undefined || depth > 12) return "unknown"
  switch (value.type) {
    case "intrinsic":
    case "unknown":
      return value.name
    case "reference": {
      const arguments_ = value.typeArguments ?? []
      return arguments_.length === 0
        ? value.name
        : `${value.name}<${arguments_.map((argument) => formatType(argument, depth + 1)).join(", ")}>`
    }
    case "union":
    case "intersection":
      return value.types.map((member) => formatType(member, depth + 1)).join(value.type === "union" ? " | " : " & ")
    case "array":
      return `Array<${formatType(value.elementType, depth + 1)}>`
    case "tuple":
      return `[${(value.elements ?? []).map((element) => formatType(element, depth + 1)).join(", ")}]`
    case "namedTupleMember":
      return `${value.name}${value.isOptional ? "?" : ""}: ${formatType(value.element, depth + 1)}`
    case "literal":
      return JSON.stringify(value.value) ?? "undefined"
    case "typeOperator":
      return `${value.operator} ${formatType(value.target, depth + 1)}`
    case "indexedAccess":
      return `${formatType(value.objectType, depth + 1)}[${formatType(value.indexType, depth + 1)}]`
    case "query":
      return `typeof ${formatType(value.queryType, depth + 1)}`
    case "reflection": {
      const signatures = value.declaration.signatures ?? []
      const children = value.declaration.children ?? []
      const indexSignatures = value.declaration.indexSignatures ?? []
      if (signatures.length === 1 && children.length === 0 && indexSignatures.length === 0) {
        return formatFunctionType(signatures[0])
      }
      return formatObjectBody(value.declaration, depth + 1)
    }
    case "optional":
      return `${formatType(value.elementType, depth + 1)}?`
    case "rest":
      return `...${formatType(value.elementType, depth + 1)}`
    case "conditional":
      return `${formatType(value.checkType, depth + 1)} extends ${formatType(value.extendsType, depth + 1)} ? ${formatType(value.trueType, depth + 1)} : ${formatType(value.falseType, depth + 1)}`
    case "inferred":
      return `infer ${value.name}${value.constraint === undefined ? "" : ` extends ${formatType(value.constraint, depth + 1)}`}`
    case "predicate":
      return `${value.asserts ? "asserts " : ""}${value.name}${value.targetType === undefined ? "" : ` is ${formatType(value.targetType, depth + 1)}`}`
    case "templateLiteral":
      return `\`${value.head}${value.tail.map(([type, text]) => `\${${formatType(type, depth + 1)}}${text}`).join("")}\``
    case "mapped":
      return `{ [${value.parameter} in ${formatType(value.parameterType, depth + 1)}]: ${formatType(value.templateType, depth + 1)} }`
    default:
      return "unknown"
  }
}

const indent = (value) => value.split("\n").map((line) => `  ${line}`).join("\n")

const reflectionKindName = (kind) => {
  switch (kind) {
    case ReflectionKind.Namespace:
      return "namespace"
    case ReflectionKind.Variable:
      return "variable"
    case ReflectionKind.Function:
      return "function"
    case ReflectionKind.Class:
      return "class"
    case ReflectionKind.Interface:
      return "interface"
    case ReflectionKind.TypeAlias:
      return "type"
    default:
      return `kind-${kind}`
  }
}

const firstSourceUrl = (sources) => sources?.find((source) => source.url !== undefined)?.url

const compareVersions = (left, right) => {
  const leftParts = left.split(".").map(Number)
  const rightParts = right.split(".").map(Number)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}
