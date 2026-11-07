---
"@typeonce/effect-machine": minor
---

Compile errors for common machine mistakes now name the fix instead of reporting `never`:

```ts
Pay: { target: "Archivd" }
// Unknown target "Archivd". Declared: Editing, Checkout, Archived

invoke: { src: "loadd", onDone: { stay: true } }
// Unknown source. Registered: load
```

`Machine.handle` reports a misspelled target, source, or owner, a missing `data`, the root or a history state used as a target, and an `on`, `always`, `onDone`, or `invoke` on a final or choice state.

A transition that targets a state below an inactive valued state, such as `{ target: "Checkout.Paid" }` from outside `Checkout`, used to fail while planning. It is now a compile error: target `"Checkout"` with a `branches` entry and construct the child with `select.target("Checkout", { data, states: { Paid: {} } })`.
