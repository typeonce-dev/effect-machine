---
"@typeonce/effect-machine": minor
---

Add safe `.from` state construction to initial and transition target builders.
Constructor inputs are resolved through the selected state schema during
planning, preserving defaults and class identity while reporting validation
failures as `MachineSchemaDecodeError` values.
