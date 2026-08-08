---
"@typeonce/effect-machine": minor
---

Replace Effectful state transition, lifecycle, choice, history, and initial
callbacks with a synchronous `(state, event) => [nextState, commands]` core.
Callbacks may enqueue only typed `raise`, `emit`, `sendTo`, and `stop`
operations; asynchronous work remains available through invoked Effects,
actors, and child machines.

Remove `Machine.action`, `Machine.runtime`, and `Machine.runActions`. Planning
now returns closed actor `commands`, while managed runtimes execute those
commands around state publication and typed emission delivery.
