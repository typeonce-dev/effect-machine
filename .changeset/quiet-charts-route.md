---
"@typeonce/effect-machine-devtools": patch
---

Improve the static statechart so initial and reachable states follow a stable left-to-right order, reverse and self-transitions use dedicated routes, and transition labels stay clear of arrowheads and compound boundaries.

Distinguish automatic transitions with dashed lines and correlate invoke outcomes with muted colors for effect, timer, stream, process, and child-machine activities.

Stack parallel regions into vertical lanes, separate states with no statically known path from the initial state, and make long or intersecting routes easier to follow with rounded corners, edge casing, and direction cues.

Add a machine analysis inspector that reports declared public events without handlers and state subtrees without a statically known path from the initial configuration.
