---
"@typeonce/effect-machine": patch
---

Allow local and branch targets to enter inactive nested parallel states. These
targets now require a complete selection for every parallel region while
preserving partial updates for parallel states that are already active.
