import { readFile } from "node:fs/promises"
import { join, relative, sep } from "node:path"

/**
 * Finds names that the public declarations of a package refer to but that no
 * consumer can write: unique symbols, interfaces, classes, and enums that are
 * not reachable through an exported entrypoint.
 *
 * A consumer that emits declarations for a value whose type expands one of
 * those names fails with TS4023 or TS2883, because TypeScript must print the
 * name and cannot inline it. Type aliases and literal-typed constants are not
 * reported, since TypeScript prints their structure instead.
 */
export const findUnnameablePublicNames = async (ts, packageDirectory) => {
  const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"))
  const entrypoints = Object.values(manifest.exports)
    .flatMap((entry) => typeof entry === "object" && typeof entry.types === "string" ? [entry.types] : [])
    .map((file) => join(packageDirectory, file))
  const packageRoot = packageDirectory + sep
  const program = ts.createProgram(entrypoints, {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: []
  })
  const checker = program.getTypeChecker()
  const resolve = (symbol) => symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
  const inPackage = (symbol) =>
    (symbol.declarations ?? []).some((declaration) => declaration.getSourceFile().fileName.startsWith(packageRoot))

  const reachable = new Set()
  const addReachable = (symbol) => {
    symbol = resolve(symbol)
    if (reachable.has(symbol)) return
    reachable.add(symbol)
    if (symbol.flags & (ts.SymbolFlags.Module | ts.SymbolFlags.Namespace)) {
      for (const member of checker.getExportsOfModule(symbol)) addReachable(member)
    }
  }
  for (const file of entrypoints) {
    const source = program.getSourceFile(file)
    if (source === undefined) throw new Error(`missing entrypoint declaration ${file}`)
    for (const exported of checker.getExportsOfModule(checker.getSymbolAtLocation(source))) addReachable(exported)
  }

  const isUnnameable = (symbol) => {
    if (symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.Class | ts.SymbolFlags.Enum)) return true
    return (symbol.flags & ts.SymbolFlags.Variable) !== 0 &&
      (checker.getTypeOfSymbol(symbol).flags & ts.TypeFlags.UniqueESSymbol) !== 0
  }
  const findings = new Map()
  const visited = new Set()
  const queue = [...reachable].filter(inPackage)
  const visitName = (node) => {
    const found = checker.getSymbolAtLocation(node)
    if (found === undefined) return
    const symbol = resolve(found)
    if (!inPackage(symbol)) return
    if (symbol.flags & (ts.SymbolFlags.TypeParameter | ts.SymbolFlags.Property | ts.SymbolFlags.Method)) return
    if (!reachable.has(symbol) && isUnnameable(symbol)) {
      const declaration = symbol.declarations[0]
      findings.set(symbol, `${symbol.name} (${relative(packageDirectory, declaration.getSourceFile().fileName)})`)
    }
    if (!visited.has(symbol)) queue.push(symbol)
  }
  const rightmost = (name) =>
    ts.isQualifiedName(name) ? name.right : ts.isPropertyAccessExpression(name) ? name.name : name
  const scan = (node) => {
    // A class is named by itself; its emitted `_base` heritage constant never is.
    if (ts.isHeritageClause(node) && ts.isClassDeclaration(node.parent)) return
    if (ts.isTypeReferenceNode(node)) visitName(rightmost(node.typeName))
    else if (ts.isExpressionWithTypeArguments(node)) visitName(rightmost(node.expression))
    else if (ts.isTypeQueryNode(node)) visitName(rightmost(node.exprName))
    else if (ts.isComputedPropertyName(node)) visitName(rightmost(node.expression))
    else if (ts.isImportTypeNode(node) && node.qualifier !== undefined) visitName(rightmost(node.qualifier))
    ts.forEachChild(node, scan)
  }
  while (queue.length > 0) {
    const symbol = queue.shift()
    if (visited.has(symbol)) continue
    visited.add(symbol)
    for (const declaration of symbol.declarations ?? []) {
      if (!declaration.getSourceFile().fileName.startsWith(packageRoot)) continue
      // Namespace members are visited through the namespace's exports.
      if (ts.isModuleDeclaration(declaration) || ts.isSourceFile(declaration)) continue
      scan(declaration)
    }
  }
  return [...findings.values()].sort()
}
