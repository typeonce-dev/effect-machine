---
"@typeonce/effect-machine-devtools": patch
---

Keep the statechart available for machines that combine nested state updates with cross-hierarchy transitions.

Self-transitions now use deterministic local routes, and layout retries with relaxed port constraints before reporting a failure.
