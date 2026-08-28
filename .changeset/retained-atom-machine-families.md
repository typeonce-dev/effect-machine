---
"@typeonce/effect-machine": minor
---

Add `AtomMachine.family` and `AtomMachine.familyChild` for keyed machine atoms that retain their machine bridge and use weak family values when the runtime supports them.

The machine startup input is the root family key. Define each public readonly or writable atom once, then look it up directly from React without `useMemo`:

```ts
const processAtoms = AtomMachine.family(processMachine, {
  atoms: {
    details: AtomMachine.select("Processing"),
    send: (machine) => machine.send
  }
})
```

Root and child selectors now also support data-last calls such as `AtomMachine.select("Processing")(machine)`.
