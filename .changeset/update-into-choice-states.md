---
"@typeonce/effect-machine": minor
---

A transition that combines `target` and `update` can now enter a choice state. The owner is updated first, so the choice resolver reads the new value through `containingState`, `ancestors`, or `root` before the chosen branch is entered. With a choice target, `data` constructs only the owner value:

```ts
Idle: {
  on: { Bump: { target: "Route", update: "root", data: ({ root }) => ({ count: root.count + 1 }) } }
}
```

A declared branch group can declare the same pair and select it with `select.route({ update: { data } })`. Every branch the choice can reach, including through nested choices, must stay below the updated owner: an escaping branch is a type error such as `Choice 'Route' branch 'out' targets 'Outside' outside the updated owner 'Flow'`, and `handle` rejects it at construction.
