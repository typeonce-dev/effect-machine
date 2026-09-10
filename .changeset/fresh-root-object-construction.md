---
"@typeonce/effect-machine": minor
---

Pass machine input directly to root initial constructors, including parallel regions, without retaining startup-only values in root data. A root transition uses `{ target: targets.root, input }` to reconstruct root and its initial children with fresh input; `reenter: true` restarts the root lifecycle when the handler is at root. Root updates continue to use `{ update: targets.root, data }` and retain active children.

Use `target` instead of `initial` on event transitions. Named branch selectors now accept one construction object: `select.checkout({ data: cart, states: { Review: { data: review } } })`. Replace `.from(value)` with `({ data: value })`, `.decoded(value)` with `({ decoded: true, data: value })`, and chained owner updates with `update: { data: owner }` inside the same call. History fallbacks use `target({ states: ... })` with a complete tree containing their owner.

Input remains limited to root construction and the root's initial callbacks. Nested initializers use state data and ancestors. Explicit subtree construction preserves source-local parallel retention, schema validation, and declared branch inspection.
