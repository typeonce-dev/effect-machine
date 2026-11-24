---
"@typeonce/effect-machine": minor
---

Each run of invoked work now owns its own `Scope` on `LocalMachine` and `AtomMachine`, as it already did on `ClusterMachine`. The scope closes when the work ends or its state is left, so resources acquired with `Effect.acquireRelease` or `Effect.addFinalizer` are released with the run instead of piling up until the machine stops.

An Effect and a Stream get a new scope for every run. Logic gets one from its `initial` through the end of its `run`. A timer acquires nothing, and a child machine's own work follows the same rule.
