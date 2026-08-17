---
"@typeonce/effect-machine": minor
---

Make `handle` a one-shot implementation boundary. `Machine.make(...)` now returns a `Machine.Definition`; calling `handle(...)` returns a `Machine` without another `handle` method.

To create multiple implementations, call `handle` independently on the original definition. Migrate chained calls by combining their state configurations into one handler tree.
