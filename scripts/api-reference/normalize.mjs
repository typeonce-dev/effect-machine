import { ReflectionKind } from "typedoc"

/**
 * Converts a TypeDoc project reflection into the stable view a website needs.
 * Raw TypeDoc JSON remains the generated artifact; this adapter isolates a
 * future site from TypeDoc's complete reflection schema.
 */
export const normalizeApiModule = (
  reflection,
  configuredUsageSections = [],
  configuredReferenceSections = []
) => {
  const moduleReflection = reflection.children?.find((child) => child.children !== undefined)
  const usageSections = normalizeUsageSections(moduleReflection, configuredUsageSections)
  const declarations = (moduleReflection?.children ?? []).map((declaration) => ({
    ...normalizeDeclaration(declaration),
    usageSections: usageSections.filter((section) =>
      section.owner === declaration.name &&
      (section.ownerKind === undefined || section.ownerKind === reflectionKindName(declaration.kind))
    )
  }))
  const referenceSections = normalizeReferenceSections(
    moduleReflection,
    configuredReferenceSections,
    declarations,
    usageSections
  )
  const groups = groupBy(declarations, (declaration) => declaration.category)
  const versions = declarations.flatMap((declaration) => declaration.since === undefined ? [] : [declaration.since])

  return {
    name: moduleReflection?.name ?? reflection.name,
    description: commentMarkdown(moduleReflection?.comment),
    since: versions.toSorted(compareVersions)[0],
    sourceUrl: declarations.find((declaration) => declaration.sourceUrl !== undefined)?.sourceUrl,
    declarationCount: declarations.length,
    referenceSections,
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
    for (const section of declaration.usageSections ?? []) {
      for (const root of section.roots) {
        if (root.description === undefined) {
          violations.push(`${declaration.name}.${section.title}.${root.label}: missing summary`)
        }
        if (root.members.length === 0) {
          violations.push(`${declaration.name}.${section.title}.${root.label}: no documented members`)
        }
        visitUsageMembers(root.members, (member, path) => {
          if (member.description === undefined) {
            violations.push(`${declaration.name}.${section.title}.${root.label}.${path}: missing summary`)
          }
        })
      }
    }
  }

  for (const section of api.referenceSections ?? []) {
    for (const entry of section.entries) {
      if (entry.api.description === undefined) {
        violations.push(`${section.title}.${entry.api.name}: missing summary`)
      }
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

const normalizeReferenceSections = (moduleReflection, configuredSections, declarations, usageSections) => {
  if (configuredSections.length === 0) return []
  const index = reflectionIndex(moduleReflection)
  return configuredSections.map((section) => ({
    title: section.title,
    description: section.description,
    entries: section.entries.map((entry) => {
      if (entry.declaration !== undefined) {
        const matches = declarations.filter((declaration) =>
          declaration.name === entry.declaration &&
          (entry.kind === undefined || declaration.kind === entry.kind)
        )
        if (matches.length !== 1) {
          throw new Error(
            `Could not uniquely resolve core API declaration: ${entry.declaration}${
              entry.kind === undefined ? "" : ` (${entry.kind})`
            }`
          )
        }
        return {
          origin: { type: "declaration", name: matches[0].name, kind: matches[0].kind },
          api: matches[0]
        }
      }

      const reflection = index.get(entry.reflection)
      if (reflection === undefined) {
        throw new Error(`Could not resolve core API reflection: ${entry.reflection}`)
      }
      const selectedUsageSections = usageSections.filter((usageSection) =>
        usageSection.owner === entry.owner &&
        (entry.ownerKind === undefined || usageSection.ownerKind === entry.ownerKind) &&
        (entry.usageSections === undefined || entry.usageSections.includes(usageSection.title))
      )
      if (
        entry.usageSections !== undefined &&
        selectedUsageSections.length !== entry.usageSections.length
      ) {
        throw new Error(`Could not resolve every usage section configured for ${entry.reflection}`)
      }
      return {
        origin: { type: "reflection", reflection: entry.reflection },
        api: normalizeReferenceReflection(reflection, entry, selectedUsageSections)
      }
    })
  }))
}

const normalizeReferenceReflection = (reflection, entry, usageSections) => {
  const comment = declarationComment(reflection)
  return {
    name: entry.label ?? reflection.name,
    kind: entry.kind ?? reflectionKindName(reflection.kind),
    category: "Core API",
    signature: usageMemberSignature(reflection),
    description: commentMarkdown(comment),
    since: blockTagText(comment?.blockTags, "@since"),
    deprecated: blockTagText(comment?.blockTags, "@deprecated"),
    see: blockTagTexts(comment?.blockTags, "@see"),
    examples: codeExamples(reflection),
    sourceUrl: firstSourceUrl(reflection.sources),
    usageSections
  }
}

const visitUsageMembers = (members, visit, prefix = "") => {
  for (const member of members) {
    const path = prefix.length === 0 ? member.name : `${prefix}.${member.name}`
    visit(member, path)
    visitUsageMembers(member.members, visit, path)
  }
}

const normalizeUsageSections = (moduleReflection, configuredSections) => {
  if (configuredSections.length === 0) return []
  const index = reflectionIndex(moduleReflection)
  const topLevel = new Map((moduleReflection?.children ?? []).map((reflection) => [reflection.name, reflection]))
  return configuredSections.map((section) => ({
    owner: section.owner,
    ownerKind: section.ownerKind,
    title: section.title,
    description: section.description,
    roots: section.roots.map((root) => {
      const reflection = root.reflection === undefined
        ? findParameter(topLevel.get(root.declaration), root.parameter)
        : index.get(root.reflection)
      if (reflection === undefined) {
        const locator = root.reflection ?? `${root.declaration} parameter ${root.parameter}`
        throw new Error(`Could not resolve API usage root: ${locator}`)
      }
      return normalizeUsageRoot(reflection, root.label ?? reflection.name, root)
    })
  }))
}

const reflectionIndex = (moduleReflection) => {
  const index = new Map()
  const visit = (reflection, path) => {
    for (const child of reflection?.children ?? []) {
      const childPath = child.name === "__type" ? path : [...path, child.name]
      if (child.name !== "__type") index.set(childPath.join("."), child)
      visit(child, childPath)
      for (const signature of child.signatures ?? []) visitSignature(signature, childPath)
      visitType(child.type, childPath)
    }
  }
  const visitSignature = (signature, path) => {
    for (const parameter of signature.parameters ?? []) {
      visitType(parameter.type, [...path, parameter.name])
    }
    visitType(signature.type, path)
  }
  const visitType = (type, path) => {
    if (type === undefined) return
    if (type.type === "reflection") {
      visit(type.declaration, path)
      for (const signature of type.declaration.signatures ?? []) visitSignature(signature, path)
      return
    }
    for (const childType of childTypes(type)) visitType(childType, path)
  }
  visit(moduleReflection, [])
  return index
}

const findParameter = (reflection, name) => {
  let found
  const visit = (value) => {
    if (found !== undefined || value === undefined) return
    for (const parameter of value.parameters ?? []) {
      if (parameter.name === name) {
        found = parameter
        return
      }
      visitType(parameter.type)
    }
    for (const signature of value.signatures ?? []) visit(signature)
    for (const child of value.children ?? []) visit(child)
    visitType(value.type)
  }
  const visitType = (type) => {
    if (found !== undefined || type === undefined) return
    if (type.type === "reflection") visit(type.declaration)
    for (const childType of childTypes(type)) visitType(childType)
  }
  visit(reflection)
  return found
}

const normalizeUsageRoot = (reflection, label, options) => ({
  label,
  name: reflection.name,
  kind: reflectionKindName(reflection.kind),
  description: commentMarkdown(declarationComment(reflection)),
  examples: codeExamples(reflection),
  members: normalizeUsageMembers(reflection, 0, options.nested === true ? 1 : 0)
    .filter((member) => options.members === undefined || options.members.includes(member.name)),
  sourceUrl: firstSourceUrl(reflection.sources)
})

const normalizeUsageMembers = (reflection, depth, maxDepth) => {
  if (depth > maxDepth) return []
  const members = memberReflections(reflection)
    .filter(isDocumentableUsageMember)
    .map((member) => normalizeUsageMember(member, depth, maxDepth))
  return mergeUsageMembers(members)
}

const normalizeUsageMember = (member, depth, maxDepth) => {
  const comment = declarationComment(member)
  return {
    name: member.name,
    signature: usageMemberSignature(member),
    description: commentMarkdown(comment),
    since: blockTagText(comment?.blockTags, "@since"),
    deprecated: blockTagText(comment?.blockTags, "@deprecated"),
    defaultValue: blockTagText(comment?.blockTags, "@defaultValue") ?? blockTagText(comment?.blockTags, "@default"),
    examples: codeExamples(member),
    parameters: normalizeUsageParameters(member),
    members: normalizeUsageMembersFromMember(member, depth + 1, maxDepth),
    sourceUrl: firstSourceUrl(member.sources)
  }
}

const normalizeUsageParameters = (member) => {
  const parameters = (member.signatures ?? []).flatMap((signature) => signature.parameters ?? [])
  return mergeBy(parameters.map((parameter) => ({
    name: parameter.name,
    signature: formatParameter(parameter),
    description: commentMarkdown(parameter.comment),
    sourceUrl: firstSourceUrl(parameter.sources)
  })), (parameter) => parameter.name)
}

const normalizeUsageMembersFromMember = (member, depth, maxDepth) => {
  if (depth > maxDepth) return []
  const nested = []
  collectTypeMembers(member.type, nested, true)
  for (const signature of member.signatures ?? []) collectTypeMembers(signature.type, nested, true)
  return mergeUsageMembers(
    nested.filter(isDocumentableUsageMember).map((child) => normalizeUsageMember(child, depth, maxDepth))
  )
}

const memberReflections = (reflection) => {
  const members = [...reflection.children ?? []]
  collectTypeMembers(reflection.type, members, false)
  return members
}

const collectTypeMembers = (type, members, includeReturnTypes) => {
  if (type === undefined) return
  if (type.type === "reflection") {
    members.push(...type.declaration.children ?? [])
    if (includeReturnTypes) {
      for (const signature of type.declaration.signatures ?? []) collectTypeMembers(signature.type, members, true)
    }
    return
  }
  for (const childType of childTypes(type)) collectTypeMembers(childType, members, includeReturnTypes)
}

const childTypes = (type) => {
  switch (type.type) {
    case "array":
      return [type.elementType]
    case "conditional":
      return [type.trueType, type.falseType]
    case "indexedAccess":
      return [type.objectType, type.indexType]
    case "intersection":
    case "union":
      return type.types ?? []
    case "mapped":
    case "optional":
    case "rest":
    case "typeOperator":
      return [type.elementType ?? type.target ?? type.parameterType]
    case "reference":
    case "tuple":
      return type.typeArguments ?? type.elements ?? []
    default:
      return []
  }
}

const isDocumentableUsageMember = (member) =>
  member.name !== "__type" &&
  !member.name.startsWith("[") &&
  !member.name.startsWith("~effect/") &&
  blockTagText(member.comment?.blockTags, "@internal") === undefined &&
  member.comment?.modifierTags?.includes("@internal") !== true &&
  !isNeverMember(member)

const isNeverMember = (member) => member.type?.type === "intrinsic" && member.type.name === "never"

const usageMemberSignature = (member) => {
  const signatures = formatMember(member, 0)
    .map((signature) => signature.replace(/;$/, ""))
  return signatures.length === 0 ? undefined : signatures.join("\n")
}

const mergeUsageMembers = (members) => {
  const groups = groupBy(members, (member) => member.name)
  return [...groups].map(([, variants]) => {
    const first = variants.find((variant) => variant.description !== undefined) ?? variants[0]
    return {
      ...first,
      signature: unique(variants.flatMap((variant) => variant.signature === undefined ? [] : [variant.signature])).join("\n"),
      parameters: mergeBy(variants.flatMap((variant) => variant.parameters), (parameter) => parameter.name),
      members: mergeUsageMembers(variants.flatMap((variant) => variant.members)),
      sourceUrl: variants.find((variant) => variant.sourceUrl !== undefined)?.sourceUrl
    }
  }).toSorted((left, right) => left.name.localeCompare(right.name))
}

const mergeBy = (values, keyOf) => [...new Map(values.map((value) => [keyOf(value), value])).values()]

const unique = (values) => [...new Set(values.filter(Boolean))]

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
