---
"@typeonce/effect-machine": minor
---

`ClusterMachine` runs the timers invoked by active states. The step that enters a state stores when its timers are due, and the entity is kept alive until they fire. An entity that comes up again, on any runner, waits only for the time that remains, and fires a timer whose time has passed at once. `LocalMachine.resume` still starts the full duration again.

The duration of a timer is evaluated after its step is planned and before the step is stored. A redelivered request can evaluate it again, so input mappers and timer sources must stay free of effects. An entity stays in memory while a timer waits, however long that is. Streams, process logic, and child machines are still rejected.

A `Storage` implementation needs no change as long as it stores `Checkpoint` whole: due times are in `status.invocations`, and `origin` can be the new `{ _tag: "Timers" }`, which `commit` treats as any origin that is not a request. Checkpoints stored before this change need nothing beyond `status: { _tag: "Active", invocations: {} }`. A state that was stored before the machine declared one of its timers is given a due time when its entity comes up. A state stored with a timer the machine no longer declares is rejected as `"InvalidCheckpoint"`, so migrate it.
