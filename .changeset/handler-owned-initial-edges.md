---
"@typeonce/effect-machine": minor
"@typeonce/effect-machine-react": minor
"@typeonce/effect-machine-devtools": minor
"@typeonce/oxlint-plugin-effect-machine": minor
---

Declare initial edges and data together in `.handle`. Remove `initial` from `Machine.state`, remove `initial` and `initialConfiguration` from `Machine.make`, and move shared startup data into the root handler's `root` value or input callback. Each compound declares `initial: { target, data? }`; parallel handlers use an `initial` map of region data. Initial targets must be direct children and remain inspectable without executing constructors.

```ts
const root = Machine.state({ states: { Locked: {}, Unlocked: {} } })
const targets = Machine.targets(root)
const machine = Machine.make({ root, events: Machine.events({ Coin: {} }) }).handle({
  initial: { target: targets.root.Locked },
  states: { Locked: { on: { Coin: { target: targets.root.Unlocked } } } }
})
```

Replace declarative `from` callbacks with `data`, which accepts literals or callbacks. Supply already-decoded values with `{ decoded: true, data: valueOrCallback }`. For root or region data that itself contains `decoded: true` and `data` fields, use a callback returning the ordinary schema input. Bound branch and history builders retain `.from` and `.decoded`. Replace command-producing `initialize` callbacks with `entry`/`exit` handlers or invocations; definitions become executable only after `.handle` captures their initial declarations.
