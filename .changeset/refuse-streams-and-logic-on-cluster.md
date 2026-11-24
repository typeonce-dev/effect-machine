---
"@typeonce/effect-machine": patch
---

Document why `ClusterMachine` refuses Streams and `Logic`: their progress lives only in memory, so work that Cluster runs again after a crash or a move would apply elements twice or lose a process's state. The docs of `Machine.InvocationSupport` now say that Cluster runs child machines, and the modeling guide names `Machine.ChildMachineRuntime`.
