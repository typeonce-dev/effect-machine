---
"@typeonce/effect-machine": minor
---

Make owning-machine requirements explicit and statically safe. Declare `parent: Machine.parent(ParentEvents)` for a child-only machine; its behavior receives a non-optional `parent`, compatible owners are checked when the child is invoked, and independent root APIs reject the machine.

Replace `parentEvents: ParentEvents` with `parent: Machine.optionalParent(ParentEvents)` when the same machine must remain valid as either a root or a child. Optional declarations retain the previous `parent | undefined` behavior. Machines without a parent declaration no longer expose `parent` in schema-first behavior contexts.
