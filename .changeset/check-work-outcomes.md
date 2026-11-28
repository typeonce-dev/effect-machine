---
"@typeonce/effect-machine": minor
---

`MachineTest.check` now explores the results of invoked work. A running timer elapses as one more branch with no option, so states behind timers are now visited and checked. An Effect's results are only a type, so you supply the values to try in `outcomes`. Each value is a separate branch. An unknown source name or a value of the wrong type does not compile:

```ts
const report = yield * MachineTest.check(LoadMachine, {
  outcomes: { loadDocument: { done: ["# Title"], failure: [new LoadError()] } }
})
```

A result is tried only while its work runs, once per entry of the state that invoked it. Findings behind a result carry it in their replay, which `MachineTest.run` plans again. A scenario's `events` can now contain `MachineTest.WorkOutcome` results, and a trace lists the work that runs in `trace.work`. A supplied result that fails the machine, which only a machine with erased types allows, is reported as an `"outcome.failsMachine"` error. A name in `outcomes` that no state invokes as an Effect is reported as an `"outcomes.invalid"` error.

The `"invocations"` limit is replaced by limits that say what was not explored: `"customOutcomes"`, `"effectsWithoutOutcomes"`, `"streams"`, `"logic"`, and `"children"`. A machine that invokes only timers can now get an `"exhaustive"` report. Step invariants now also run on result steps, so narrow `event` with `MachineTest.isWorkOutcome` before you read event fields. `transition.notCovered` now warns about an `onDone` or `onFailure` branch that the supplied values could have taken and did not.
