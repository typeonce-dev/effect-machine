---
"@typeonce/effect-machine": minor
"@typeonce/effect-machine-react": minor
"@typeonce/effect-machine-devtools": minor
---

The keep-alive request of a `ClusterMachine` is now held for as long as its work runs or its timers wait. It is not replaced periodically, so no crash can fall into the gap of a replacement.

`ClusterMachine` needs `effect` 4.1.5 or later for this. Earlier versions answer the keep-alive request of a Cluster entity after about ten minutes, and a machine whose work runs longer would not come up again after a crash. The packages still accept every stable `effect` 4.x, so a project that uses `ClusterMachine` has to install 4.1.5 or later itself, together with matching `@effect/*` packages.
