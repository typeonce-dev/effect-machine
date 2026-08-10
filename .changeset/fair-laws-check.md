---
"@typeonce/effect-machine": minor
---

Add state, step, and trace invariants for checking application semantics over planner traces, including machine-inferred builders, conditional observation requirements, structured reports, and property-test assertions. Add bounded breadth-first exploration with state-dependent event representatives, shortest witnesses, explicit truncation frontiers, and fail-closed reachability assertions. Add testing-only runtime probes with acknowledged event delivery so tests can causally inspect ignored, targetless, changing, and failed live macrosteps without adding a production `sendAndAwait` API.
