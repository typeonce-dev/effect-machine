---
"@typeonce/effect-machine": minor
---

Add `Machine.waitFor(ref, predicate)` for external Effects and tests awaiting a current or subsequent published snapshot. Type predicates narrow the result. Unmatched failures preserve their Cause, stopping fails with `StoppedError`, and completion without a match fails with `Cause.NoSuchElementError`. Compose `Effect.timeout` to bound the wait; cancellation releases observation without stopping the machine.

Effect, Stream, and timer invocations now run inside `Machine.invoke` spans with machine, state, source, and invocation identity. Use ordinary Effect tracing configuration to export them. This preserves resource ownership and does not propagate each sender's trace context through the mailbox.

Fix indexed self-transitions and reentry for states without a value schema, so their invocations restart consistently with the generic runtime.
