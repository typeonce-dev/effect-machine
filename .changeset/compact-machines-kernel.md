---
"@typeonce/effect-machine": patch
---

Run compiled statecharts on a compact, class-backed process kernel that shares operation implementations and materializes terminal and observation primitives only when used. This reduces retained memory and improves runtime throughput while preserving the general `Machine.logic` process contract, lifecycle arbitration, child cleanup, and public `MachineRef` API.
