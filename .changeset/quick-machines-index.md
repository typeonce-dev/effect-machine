---
"@typeonce/effect-machine": patch
---

Run eligible flat machines on the same indexed execution representation as compound and parallel machines, with a specialized single-root dispatch loop and owner-local state slots. This removes the separate flat configuration executor while preserving schema validation, raised events, immutable public snapshots, resume behavior, and terminal completion.
