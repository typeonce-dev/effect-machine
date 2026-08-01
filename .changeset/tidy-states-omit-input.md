---
"@typeonce/effect-machine": minor
---

Allow state builder `.from()` calls to omit the constructor input when the
selected schema accepts `{}`. Required fields and compound or parallel child
selection remain type-safe, and omitted inputs still run through schema
construction during planning.
