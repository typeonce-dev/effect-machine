---
"@typeonce/effect-machine": minor
---

Replace `Machine.invokeEffect`, `Machine.after`, `Machine.invokeMachine`, and `Machine.effect` with one inline `invoke` lifecycle object API and a zero-runtime `Machine.invoke` inference helper.

Choose an `effect`, `after`, `logic`, or `child` source and handle typed outcomes directly with `onDone`, `onFailure`, and `onSnapshot`. Lifecycle handlers can now transition the owning state without routing results through mapped machine events.
