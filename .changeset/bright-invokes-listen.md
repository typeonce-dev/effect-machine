---
"@typeonce/effect-machine": patch
---

Fix `Machine.invoke(...)` inside `.handle(...)` so invocation sources and lifecycle handlers receive the owning machine's typed `self` and `parent` protocols.

Event protocol examples now pass tagged unions directly to `Machine.events`, `Machine.internalEvents`, and `Machine.emittedEvents`, avoiding throwaway schema bindings.
