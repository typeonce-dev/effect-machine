---
"@typeonce/effect-machine": minor
"@typeonce/effect-machine-devtools": minor
---

Add `MachineTest.check`, `MachineTest.analyze`, and the `effect-machine check` command, so a machine can be verified with one call and no browser.

`check` reports states with no path from the initial state, public events with no handler, nondeterministic planning, planner law violations, invariant failures, and declared branches that were never taken. It derives input and events from the machine's schemas, and each finding from a run includes the events that reproduce it. A report is `"exhaustive"` only when nothing limited exploration; otherwise `limits` says why it is `"bounded"`.

```ts
const program = Effect.gen(function*() {
  const report = yield* MachineTest.check(Checkout)
  return report.ok // false when any finding is an error
})
```

From a shell, `effect-machine check src/checkout.ts --json` prints one JSON object and exits with status 1 on any error.
