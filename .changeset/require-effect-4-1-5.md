---
"@typeonce/effect-machine": minor
"@typeonce/effect-machine-react": minor
"@typeonce/effect-machine-devtools": minor
---

Effect Machine requires `effect` `^4.1.5`, together with every `@effect/*` package you install. Earlier versions answer the keep-alive request of a Cluster entity after ten minutes, and a `ClusterMachine` whose work runs longer would no longer come up again after a crash. The packages share one range, so it also applies to projects that do not use Cluster.

The keep-alive request of a `ClusterMachine` is now held for as long as its work runs or its timers wait. It is not replaced periodically, so no crash can fall into the gap of a replacement.

To migrate, upgrade `effect` and the matching `@effect/*` packages to `4.1.5` or a later 4.x version.
