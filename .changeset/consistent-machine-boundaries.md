---
"@typeonce/effect-machine": patch
"@typeonce/effect-machine-devtools": patch
"@typeonce/oxlint-plugin-effect-machine": patch
---

Align `Machine.can` types with its existing support for public and internal events. Querying an internal event does not make it sendable through `MachineRef.send`. Preserve interruption during snapshot encoding and decoding, validate reused event and emission values, and capture machine definitions independently of caller mutations.

Make `MachineTest.verify` lazy and compare decoded values without lossy JSON serialization. Serialize concurrent devtools refreshes, stop watcher work with its server scope, and prevent lint rules from matching shadowed machine bindings.
