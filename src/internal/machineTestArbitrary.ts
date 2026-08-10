import * as Schema from "effect/Schema"
import * as SchemaAST from "effect/SchemaAST"
import { FastCheck } from "effect/testing"

/**
 * Warning emitted when schema arbitrary generation must enforce an opaque
 * filter through rejection sampling.
 *
 * @category models
 * @since 4.0.0
 */
export interface SchemaArbitraryOpaqueFilterWarning {
  readonly _tag: "OpaqueFilter"
  readonly path: ReadonlyArray<PropertyKey>
  readonly description?: string
}

/**
 * Non-fatal diagnostic emitted while deriving a schema arbitrary.
 *
 * @category models
 * @since 4.0.0
 */
export type SchemaArbitraryWarning = SchemaArbitraryOpaqueFilterWarning

/**
 * Diagnostics collected while deriving a schema arbitrary.
 *
 * @category models
 * @since 4.0.0
 */
export interface SchemaArbitraryReport {
  readonly warnings: ReadonlyArray<SchemaArbitraryWarning>
}

const reportChecks = (
  warnings: Array<SchemaArbitraryWarning>,
  checks: SchemaAST.Checks | undefined,
  path: ReadonlyArray<PropertyKey>
): void => {
  const visit = (check: SchemaAST.Check<unknown>, covered: boolean): void => {
    const arbitrary = check.annotations?.arbitrary
    const nextCovered = covered || arbitrary?.constraint !== undefined || arbitrary?.candidate !== undefined
    if (check._tag !== "Filter") {
      for (const child of check.checks) visit(child, nextCovered)
    } else if (!nextCovered) {
      const description = check.annotations?.representation?.id ?? check.annotations?.identifier ??
        check.annotations?.expected
      warnings.push({
        _tag: "OpaqueFilter",
        path,
        ...(description === undefined ? {} : { description })
      })
    }
  }
  checks?.forEach((check) => visit(check, false))
}

const reportFor = (ast: SchemaAST.AST): SchemaArbitraryReport => {
  const warnings: Array<SchemaArbitraryWarning> = []
  const stack = new WeakSet<SchemaAST.AST>()
  const visit = (ast: SchemaAST.AST, path: ReadonlyArray<PropertyKey>): void => {
    if (stack.has(ast)) return
    stack.add(ast)
    reportChecks(warnings, ast.checks, path)
    switch (ast._tag) {
      case "Declaration":
        ast.typeParameters.forEach((typeParameter) => visit(typeParameter, path))
        break
      case "Arrays": {
        const elements = [...ast.elements, ...ast.rest]
        elements.forEach((type, index) => visit(type, [...path, index]))
        break
      }
      case "Objects":
        ast.propertySignatures.forEach((property) => visit(property.type, [...path, property.name]))
        ast.indexSignatures.forEach((index) => {
          visit(index.parameter, path)
          visit(index.type, path)
        })
        break
      case "Union":
        ast.types.forEach((type) => visit(type, path))
        break
      case "TemplateLiteral":
        ast.parts.forEach((part, index) => visit(SchemaAST.toEncoded(part), [...path, index]))
        break
      case "Suspend":
        visit(ast.thunk(), path)
        break
    }
    stack.delete(ast)
  }
  visit(ast, [])
  return { warnings }
}

/** @internal */
export const toArbitraryWithReport = <S extends Schema.Constraint>(schema: S) => ({
  value: Schema.toArbitrary(schema)(FastCheck),
  report: reportFor(schema.ast)
})
