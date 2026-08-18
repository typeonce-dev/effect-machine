---
"@typeonce/effect-machine": minor
---

Add `stream` sources to `Machine.invoke`. Stream values are handled through the typed `onElement` transition one committed parent macrostep at a time, while completion and typed failures use `onDone` and `onFailure`. Leaving the owning state interrupts the Stream and runs its finalizers.

Add the direct `{ target: Machine.targetless, resolve }` transition shorthand for handlers that keep the current configuration and only enqueue commands.
