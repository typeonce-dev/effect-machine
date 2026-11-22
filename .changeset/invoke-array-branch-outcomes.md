---
"@typeonce/effect-machine": patch
---

Fix `invoke` arrays rejecting `resolve` as an excess property when an entry's outcome declares `branches` and `resolve`.

Each entry in an `invoke: [...]` array now accepts the same outcome shapes as a single `invoke: { ... }` object, and unknown targets in any entry are still reported.
