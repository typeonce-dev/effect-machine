---
"@typeonce/effect-machine-devtools": minor
---

Add a local `effect-machine` command that discovers exported `.handle(...)` machines, keeps their last valid inspection document across incomplete reloads, and serves the live interactive text visualizer.

Native file-system events are used by default. Pass `--watch-polling` on platforms where native events are unavailable.
