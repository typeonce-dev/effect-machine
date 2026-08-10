import { basename, dirname, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const ruleDescriptions = {
  ARCH001: "Public entrypoints may only expose public modules",
  ARCH002: "Public modules may only reach internals through their designated implementation seam",
  ARCH003: "Core internals may only refer back to Machine through type-only imports",
  ARCH004: "The planner may not depend on process or runtime execution",
  ARCH006: "The runtime may not depend on machine semantics or process orchestration",
  ARCH007: "Production modules may not depend on testing internals",
  ARCH008: "Black-box tests may not depend on implementation internals",
  ARCH009: "Production runtime imports must be acyclic",
  ARCH011: "Internal directories may not use barrel modules",
  ARCH012: "Internal filenames must describe their responsibility without a machine prefix",
  ARCH013: "Public implementation bindings must declare their API signature"
}

const normalizePath = (path) => path.split(sep).join("/")

const projectPath = (rootDirectory, path) => normalizePath(relative(rootDirectory, path))

const isProjectSource = (path) =>
  path.startsWith("src/") || path.startsWith("test/") || path.startsWith("typetest/")

const isTypeOnlyImport = (node) => {
  const clause = node.importClause
  if (clause === undefined) return false
  if (clause.isTypeOnly) return true
  if (clause.name !== undefined) return false
  if (clause.namedBindings === undefined) return false
  if (ts.isNamespaceImport(clause.namedBindings)) return false
  return clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((element) => element.isTypeOnly)
}

const isTypeOnlyExport = (node) => {
  if (node.isTypeOnly) return true
  if (node.exportClause === undefined || !ts.isNamedExports(node.exportClause)) return false
  return node.exportClause.elements.length > 0 && node.exportClause.elements.every((element) => element.isTypeOnly)
}

const lineAndColumn = (sourceFile, node) => {
  const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return { line: location.line + 1, column: location.character + 1 }
}

const diagnostic = (rule, sourceFile, node, path, message) => ({
  rule,
  path,
  ...lineAndColumn(sourceFile, node),
  message
})

const compareDiagnostics = (left, right) =>
  left.path.localeCompare(right.path) ||
  left.line - right.line ||
  left.column - right.column ||
  left.rule.localeCompare(right.rule) ||
  left.message.localeCompare(right.message)

const resolveProjectModule = (specifier, sourceFile, compilerOptions, rootDirectory) => {
  const resolvedModule = ts.resolveModuleName(specifier, sourceFile.fileName, compilerOptions, ts.sys).resolvedModule
  if (resolvedModule === undefined) return undefined
  const path = projectPath(rootDirectory, resolvedModule.resolvedFileName)
  return isProjectSource(path) ? path : undefined
}

const collectEdges = (program, rootDirectory) => {
  const edges = []
  const compilerOptions = program.getCompilerOptions()

  for (const sourceFile of program.getSourceFiles()) {
    const source = projectPath(rootDirectory, sourceFile.fileName)
    if (!isProjectSource(source)) continue

    const addEdge = (moduleSpecifier, typeOnly, node) => {
      const target = resolveProjectModule(moduleSpecifier.text, sourceFile, compilerOptions, rootDirectory)
      if (target !== undefined) {
        edges.push({ source, target, typeOnly, sourceFile, node })
      }
    }

    const visit = (node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        addEdge(node.moduleSpecifier, isTypeOnlyImport(node), node)
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
        addEdge(node.moduleSpecifier, isTypeOnlyExport(node), node)
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        addEdge(node.arguments[0], false, node)
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }

  return edges
}

const stronglyConnectedComponents = (nodes, adjacency) => {
  let nextIndex = 0
  const indices = new Map()
  const lowLinks = new Map()
  const stack = []
  const onStack = new Set()
  const components = []

  const connect = (node) => {
    const index = nextIndex++
    indices.set(node, index)
    lowLinks.set(node, index)
    stack.push(node)
    onStack.add(node)

    for (const target of adjacency.get(node) ?? []) {
      if (!indices.has(target)) {
        connect(target)
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(target)))
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(target)))
      }
    }

    if (lowLinks.get(node) !== indices.get(node)) return
    const component = []
    while (stack.length > 0) {
      const current = stack.pop()
      onStack.delete(current)
      component.push(current)
      if (current === node) break
    }
    components.push(component)
  }

  for (const node of nodes) {
    if (!indices.has(node)) connect(node)
  }
  return components
}

const collectCycleDiagnostics = (program, rootDirectory, runtimeEdges) => {
  const sourceFiles = new Map()
  for (const sourceFile of program.getSourceFiles()) {
    const path = projectPath(rootDirectory, sourceFile.fileName)
    if (path.startsWith("src/")) sourceFiles.set(path, sourceFile)
  }
  const nodes = new Set(sourceFiles.keys())
  const adjacency = new Map()
  for (const edge of runtimeEdges) {
    if (!edge.source.startsWith("src/") || !edge.target.startsWith("src/")) continue
    const targets = adjacency.get(edge.source) ?? new Set()
    targets.add(edge.target)
    adjacency.set(edge.source, targets)
  }

  const diagnostics = []
  for (const component of stronglyConnectedComponents(nodes, adjacency)) {
    const selfCycle = component.length === 1 && adjacency.get(component[0])?.has(component[0]) === true
    if (component.length < 2 && !selfCycle) continue
    const paths = [...component].sort()
    const source = paths[0]
    const sourceFile = sourceFiles.get(source)
    diagnostics.push({
      rule: "ARCH009",
      path: source,
      line: 1,
      column: 1,
      message: `Runtime import cycle: ${paths.join(" -> ")}`,
      sourceFile
    })
  }
  return diagnostics
}

const readProject = (rootDirectory, tsconfigPath) => {
  const configPath = resolve(rootDirectory, tsconfigPath)
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
  if (configFile.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"))
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dirname(configPath), undefined, configPath)
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"))
  }
  const architectureFiles = ts.sys.readDirectory(
    rootDirectory,
    [".ts"],
    ["**/dist/**", "**/node_modules/**", "**/references/**"],
    ["src/**/*.ts", "test/**/*.ts", "typetest/**/*.ts"]
  )
  return ts.createProgram({
    rootNames: [...new Set([...parsed.fileNames, ...architectureFiles])],
    options: parsed.options
  })
}

export const checkArchitecture = ({
  rootDirectory = process.cwd(),
  tsconfigPath = "tsconfig.json"
} = {}) => {
  const root = resolve(rootDirectory)
  const program = readProject(root, tsconfigPath)
  const edges = collectEdges(program, root)
  const runtimeEdges = edges.filter((edge) => !edge.typeOnly)
  const diagnostics = []
  const entrypoints = new Set([
    "src/index.ts",
    "src/testing/index.ts",
    "src/unstable/cluster/index.ts",
    "src/unstable/reactivity/index.ts"
  ])
  const implementationSeams = new Map([
    ["src/Machine.ts", "src/internal/machine/machine.ts"],
    ["src/testing/MachineTest.ts", "src/internal/testing/machine/verification.ts"],
    ["src/unstable/reactivity/AtomMachine.ts", "src/internal/machine/atom.ts"],
    ["src/unstable/cluster/ClusterMachine.ts", "src/internal/machine/cluster.ts"]
  ])

  for (const edge of edges) {
    if (entrypoints.has(edge.source) && edge.target.includes("/internal/")) {
      diagnostics.push(diagnostic(
        "ARCH001",
        edge.sourceFile,
        edge.node,
        edge.source,
        `Public entrypoint imports internal module ${edge.target}`
      ))
    }
    const implementationSeam = implementationSeams.get(edge.source)
    if (
      implementationSeam !== undefined &&
      !edge.typeOnly &&
      edge.target.includes("/internal/") &&
      edge.target !== implementationSeam
    ) {
      diagnostics.push(diagnostic(
        "ARCH002",
        edge.sourceFile,
        edge.node,
        edge.source,
        `Public module bypasses its implementation seam through ${edge.target}`
      ))
    }
    if (
      edge.source.startsWith("src/internal/machine/") &&
      edge.target === "src/Machine.ts" &&
      !edge.typeOnly
    ) {
      diagnostics.push(diagnostic(
        "ARCH003",
        edge.sourceFile,
        edge.node,
        edge.source,
        "Core internal back-reference to Machine must be type-only"
      ))
    }
    if (
      edge.source === "src/internal/machine/planner.ts" &&
      !edge.typeOnly &&
      (edge.target === "src/internal/machine/process.ts" || edge.target === "src/internal/machine/runtime.ts")
    ) {
      diagnostics.push(diagnostic(
        "ARCH004",
        edge.sourceFile,
        edge.node,
        edge.source,
        `Planner has a runtime dependency on ${edge.target}`
      ))
    }
    if (
      edge.source === "src/internal/machine/runtime.ts" &&
      [
        "src/internal/machine/model.ts",
        "src/internal/machine/planner.ts",
        "src/internal/machine/process.ts"
      ].includes(edge.target)
    ) {
      diagnostics.push(diagnostic(
        "ARCH006",
        edge.sourceFile,
        edge.node,
        edge.source,
        `Runtime depends on higher-level module ${edge.target}`
      ))
    }
    if (
      edge.source.startsWith("src/") &&
      !edge.source.startsWith("src/testing/") &&
      !edge.source.startsWith("src/internal/testing/") &&
      edge.target.startsWith("src/internal/testing/")
    ) {
      diagnostics.push(diagnostic(
        "ARCH007",
        edge.sourceFile,
        edge.node,
        edge.source,
        `Production module imports testing internal ${edge.target}`
      ))
    }
    if (
      (edge.source.startsWith("test/") || edge.source.startsWith("typetest/")) &&
      !edge.source.startsWith("test/internal/") &&
      edge.target.startsWith("src/internal/")
    ) {
      diagnostics.push(diagnostic(
        "ARCH008",
        edge.sourceFile,
        edge.node,
        edge.source,
        `Black-box test imports implementation internal ${edge.target}`
      ))
    }
  }

  for (const sourceFile of program.getSourceFiles()) {
    const path = projectPath(root, sourceFile.fileName)
    const implementationSeam = implementationSeams.get(path)
    if (implementationSeam !== undefined) {
      const implementationNamespaces = new Set()
      const implementationValues = new Set()
      for (const statement of sourceFile.statements) {
        if (
          !ts.isImportDeclaration(statement) ||
          statement.importClause === undefined ||
          statement.importClause.isTypeOnly ||
          !ts.isStringLiteral(statement.moduleSpecifier) ||
          resolveProjectModule(
              statement.moduleSpecifier.text,
              sourceFile,
              program.getCompilerOptions(),
              root
            ) !== implementationSeam
        ) continue
        if (statement.importClause.name !== undefined) {
          implementationValues.add(statement.importClause.name.text)
        }
        const bindings = statement.importClause.namedBindings
        if (bindings === undefined) continue
        if (ts.isNamespaceImport(bindings)) {
          implementationNamespaces.add(bindings.name.text)
        } else {
          for (const element of bindings.elements) {
            if (!element.isTypeOnly) implementationValues.add(element.name.text)
          }
        }
      }
      for (const statement of sourceFile.statements) {
        if (
          !ts.isVariableStatement(statement) ||
          !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
        ) continue
        for (const declaration of statement.declarationList.declarations) {
          if (declaration.initializer === undefined) continue
          const bindsImplementation =
            (ts.isPropertyAccessExpression(declaration.initializer) &&
              ts.isIdentifier(declaration.initializer.expression) &&
              implementationNamespaces.has(declaration.initializer.expression.text)) ||
            (ts.isIdentifier(declaration.initializer) && implementationValues.has(declaration.initializer.text))
          if (!bindsImplementation) continue
          if (declaration.type === undefined) {
            diagnostics.push(diagnostic(
              "ARCH013",
              sourceFile,
              declaration,
              path,
              "Public implementation binding relies on an inferred internal signature"
            ))
          }
        }
      }
    }
    if (!path.startsWith("src/internal/")) continue
    if (basename(path) === "index.ts") {
      diagnostics.push({
        rule: "ARCH011",
        path,
        line: 1,
        column: 1,
        message: "Internal barrel modules hide dependency direction"
      })
    }
    if (/^machine[A-Z]/.test(basename(path))) {
      diagnostics.push({
        rule: "ARCH012",
        path,
        line: 1,
        column: 1,
        message: "Internal filename repeats the machine domain prefix"
      })
    }
  }

  diagnostics.push(...collectCycleDiagnostics(program, root, runtimeEdges))
  return diagnostics.sort(compareDiagnostics)
}

export const formatArchitectureDiagnostics = (diagnostics) =>
  diagnostics.map((item) =>
    `${item.rule} ${item.path}:${item.line}:${item.column} ${item.message}\n` +
    `  ${ruleDescriptions[item.rule]}`
  ).join("\n")

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  const diagnostics = checkArchitecture()
  if (diagnostics.length > 0) {
    console.error(formatArchitectureDiagnostics(diagnostics))
    process.exitCode = 1
  } else {
    console.log("Architecture checks passed")
  }
}
