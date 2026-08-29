---
"@typeonce/effect-machine": minor
---

Add `Machine.can` for testing whether a concrete public event would select a transition from a snapshot. It preserves schema failures, honors declinable handlers and hierarchy, and does not execute transition lifecycle or collected work.

Add `AtomMachine.factory` and bound `factory` for reusable, fully inferred machine bridge constructors. Every call creates a fresh lazy bridge, while `ReturnType<typeof constructor>` preserves the exact machine and bound runtime error types.
