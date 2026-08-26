---
"@typeonce/effect-machine-devtools": patch
---

Improve the static statechart so initial and reachable states follow a stable left-to-right order, reverse and self-transitions use dedicated routes, and transition labels stay clear of arrowheads and compound boundaries.

Distinguish automatic transitions with dashed lines and correlate invoke outcomes with muted colors for effect, timer, stream, process, and child-machine activities.
