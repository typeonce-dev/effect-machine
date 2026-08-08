import "effect/SchemaAST"

// effect@4.0.0-beta.105 references this internal type from Schema.d.ts but
// omits it from the published SchemaAST.d.ts declaration.
declare module "effect/SchemaAST" {
  export interface Sentinel {
    readonly key: PropertyKey
    readonly literal: unknown
  }
}
