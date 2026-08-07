---
"@typeonce/effect-machine": minor
---

Add first-class logical snapshot resumption with `Machine.resume`, plus lazy
`AtomMachine.resume` and bound-runtime integration. Resumed machines validate
decoded snapshots, preserve logical history and completion metadata, and create
fresh managed invokes, children, scopes, and timers without replaying historical
statechart work.
