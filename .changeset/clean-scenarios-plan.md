---
"@typeonce/effect-machine": patch
---

Keep `MachineTest.run` service-free for machines with invoked effects, matching the pure `Machine.planInitial` and `Machine.plan` APIs it uses internally.
