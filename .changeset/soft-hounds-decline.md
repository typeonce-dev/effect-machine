---
"@typeonce/effect-machine": minor
---

Add opt-in declinable transitions for conditional statechart dispatch.

Set `declinable: true` on `Machine.transition` to expose a typed `decline()` resolver capability. Declining selects no transition, discards operations enqueued by that resolver, and lets hierarchical event or eventless dispatch continue with the next eligible ancestor. `target.none()` remains handled and continues to consume the trigger.

Declining a completion or invocation outcome ignores that lifecycle occurrence because those triggers do not dispatch to ancestor handlers.

Static transition definitions now expose `acceptance: "required" | "declinable"` alongside their exact target branches. Choices and initial routing remain total and reject declinable transitions.
