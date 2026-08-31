---
"@typeonce/effect-machine-devtools": patch
---

Keep charts available for machines that transition between compound states and nested children.

Hierarchy routes now follow the vertical chart direction with stable source, terminal, label, and initial-marker clearance. This includes multi-branch fan-out and returns to a parent's initial configuration.

Parent-origin cues now identify transitions from an ancestor into deeply nested descendants. Transitions owned by parallel states, including child-invocation outcomes, use short local corridors instead of long ELK detours across the container.
