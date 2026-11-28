---
"@typeonce/effect-machine": patch
---

`MachineTest.run`, `MachineTest.explore`, and `MachineTest.check` now follow which work runs with the same rules as every host. Work invoked as `Logic` or as a child machine ends when a transition stops it with `enqueue.stop`, so `trace.work` no longer lists it, and `MachineTest.check` tells the state after the stop apart from the state before it.

A `Machine.toStep` step whose planning fails the machine now names the event it planned in `event`. A result of work that fails the machine without a transition still plans no event, so a host can tell the two apart.
