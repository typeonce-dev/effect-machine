---
"@typeonce/effect-machine": patch
---

Reuse the validated statechart configuration while draining queued event batches, avoiding repeated snapshot normalization without retaining the cache while a machine is idle. Canonicalize history snapshot paths in machine document order so batched and public planning produce identical snapshots.
