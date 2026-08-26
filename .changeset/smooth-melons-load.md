---
"@typeonce/oxlint-plugin-effect-machine": patch
---

Fix the published plugin entrypoints so Oxlint loads built JavaScript instead of TypeScript source under `node_modules`.

Upgrade from `0.26.0` without changing the Oxlint configuration. Both the package root and the recommended configuration now resolve to built files.
