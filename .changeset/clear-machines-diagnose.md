---
"@typeonce/effect-machine": patch
---

Improve compile-time diagnostics for invalid state definitions, event protocols,
and handler configurations. Errors now retain the relevant configuration shape
and state path while preserving existing inference and type safety.
