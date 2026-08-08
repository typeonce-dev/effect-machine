---
"@typeonce/effect-machine": patch
---

Allocate change-observation resources only when a machine's `changes` stream is first consumed, while preserving snapshot replay, terminal completion, and the existing `MachineRef` API.
