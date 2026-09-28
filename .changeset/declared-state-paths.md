---
"@typeonce/effect-machine": minor
---

Replace `Machine.targets(Root)` references with declared state paths. Transitions, initial edges, history, owner updates, and named branches now take dotted path strings, spelled the same way as snapshot paths. They are checked against the root passed to `make` and suggested by the editor. The root node is `"root"`, so a top-level state can no longer use that name.

Restart the machine from fresh input with `initialize`, which replaces root targets. Machines without input use `initialize: true`, and branch declarations use `{ initialize: true }` with `select.branch({ input })`.

```ts
Machine.make({ root: Root, input: Input, events: Events }).handle({
  initial: { target: "Idle" },
  on: {
    Increment: { update: "root", data: ({ root }) => ({ ...root, count: root.count + 1 }) },
    Reset: { initialize: ({ event }) => ({ id: event.id }), reenter: true }
  },
  states: { Idle: { on: { Resume: { history: "Checkout.recent" } } } }
})
```

To migrate, remove `Machine.targets`. Replace `targets.root.A.B` with `"A.B"`, `update: targets.root` with `update: "root"`, and `{ target: targets.root, input }` with `{ initialize: input }`. Rename any top-level state named `root`. Declarations stored in variables before they reach `make` or `.handle` need `as const`.
