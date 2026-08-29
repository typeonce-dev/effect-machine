---
"@typeonce/effect-machine": minor
---

Add `AtomMachine.can` for reactive event-acceptance queries with lifecycle-aware failures and stable derived atom identity.

Declare a projection once from a concrete event or an atom containing a changing event, then apply it to compatible machine bridges:

```ts
const submitAllowed = AtomMachine.can(AuthEvents.Submitted())
const canSubmitAtom = submitAllowed(authMachineAtom)
```
