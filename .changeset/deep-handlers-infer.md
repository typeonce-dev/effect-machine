---
"@typeonce/effect-machine": patch
---

Remove the library-owned eight-level handler-tree inference ceiling. Nested
handler validation and accumulated state, error, service, choice, history, and
output evidence now continue until TypeScript's normal compiler limits.
