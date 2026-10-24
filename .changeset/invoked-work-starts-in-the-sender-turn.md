---
"@typeonce/effect-machine": minor
---

Start work invoked by an entered state in the sender's turn. When `MachineRef.send` processes an event on an idle machine, each invocation the event enters runs until it first suspends before `send` returns. A browser call that requires user activation, such as `window.open` or `navigator.clipboard.writeText`, now works in the first step of an invoked Effect when the event is sent from a click handler.

An invocation's outcome is still handled in a later turn, even when the work completes without suspending, so the entered state is always observed before `onDone` or `onFailure` leaves it. Synchronous work before the first suspension now runs on the sender; keep expensive computation behind a suspension.
