---
"@typeonce/effect-machine": minor
---

Add `Machine.events(machine)` and `Machine.internalEvents(machine)` as the standard way to construct protocol events.

The returned tag-keyed constructors preserve schema make inputs and defer decoding until machine delivery, so invalid values fail with `MachineSchemaDecodeError` through planning or the running machine instead of throwing at the construction call site.
