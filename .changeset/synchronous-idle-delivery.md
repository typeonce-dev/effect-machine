---
"@typeonce/effect-machine": minor
---

Process an event sent to an idle local machine in the sender's turn. When `MachineRef.send` returns, work that completes without suspending, including raised events and the committed state, is reflected by `snapshot`. Suspending work, such as a started invocation, continues in the background, and events sent while the machine is processing are queued behind it. `changes` subscribers still receive every snapshot in order once the sender yields. `MachineTarget.send` keeps promising only delivery.

`AtomMachine` snapshot and selector atoms now update before the event handler that wrote to `send` returns. Controlled inputs bound to machine state keep their value, and form validation reads the current input.

Stopping an idle machine now completes an observed `emissions` stream.
