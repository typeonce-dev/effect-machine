---
"@typeonce/effect-machine": minor
---

Exported machines now get compact declarations. `.handle` returns `Machine.Machine<…>` directly, so a library's emitted `.d.ts` names a machine by its schemas and outcomes instead of printing the whole handler config with every handler's context. The machine's type is unchanged. Declarations of `Machine.child` and `Machine.childFamily` descriptors built from a handled machine shrink the same way.

`Machine.Machine.HandleTreeResult` is removed. Regenerate declarations that name it; the regenerated declarations name `Machine.Machine<…>` instead.
