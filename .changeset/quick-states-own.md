---
"@typeonce/effect-machine": patch
---

Store compiled machine snapshots in an owner-only mutable reference while
retaining atomic terminal reservation and lazy observation. This reduces
transition overhead and idle heap without changing the public API, event
ordering, or terminal behavior.
