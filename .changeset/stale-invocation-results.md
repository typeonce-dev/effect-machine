---
"@typeonce/effect-machine": patch
---

Fix invocation results that were already queued when their state exited. Such a result no longer runs `onDone`, `onFailure`, `onElement`, or `onSnapshot` for the invocation started when the state is entered again, whether through `reenter: true`, an ancestor's reentry, or a separate exit and entry.

This applies to Effect, Stream, timer, `Logic`, and child machine invocations. A result produced while its state stays active is still delivered, even after a finished child has been removed.
