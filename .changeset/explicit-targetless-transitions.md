---
"@typeonce/effect-machine": minor
---

Add `target.none()` for explicit targetless transitions. Every installed transition handler now returns a concrete target or `target.none()`; declared `targets` remain an upper bound on concrete destinations and never exclude `target.none()`.

Remove `Machine.retag`. To reuse compatible fields across sibling states, destructure away the source discriminator and construct the destination through its target builder:

```ts
const { _tag: _, ...fields } = state
return target.local.Saving.from({ ...fields, attempt: 1 })
```
