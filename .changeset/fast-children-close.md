---
"@typeonce/effect-machine": patch
---

Reduce child lifecycle overhead by reserving child starts atomically and specializing zero- and one-item invoke cleanup without weakening parallel finalization.
