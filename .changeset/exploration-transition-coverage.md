---
"@typeonce/effect-machine": minor
---

Add exact `transitionCoverage` to `MachineTest.Exploration`. Coverage includes startup and every concretely planned event, including state-limit candidates, while unplanned depth- and transition-limit frontiers remain misses.
