---
"@typeonce/effect-machine": minor
---

Exported values whose types expand public Effect Machine types now emit declarations with `declaration: true`. Interfaces such as `Machine.Machine`, `Machine.ChildMachine`, the target and transition results, and event constructions were keyed by private symbols, so a declaration that printed their members, for example through a mapped type, failed with TS4023. Their type-level keys are now string literals in the same form as `Machine.TypeId`, such as `"~effect/Machine/NoTarget"`. These keys exist only in the types; runtime values are unchanged.

`Machine.StateDeclaration` names the declaration accepted by `Machine.state`, so a helper can use it as a constraint. `AtomMachine.select` and `AtomMachine.can` can now be re-exported from a module that emits declarations.
