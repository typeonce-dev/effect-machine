---
"@typeonce/effect-machine": patch
---

Fix `AtomMachine` selectors so machines and invoked children with declared emitted events retain typed state selection and matching after `make` or `bind`.
