---
"@typeonce/effect-machine": patch
---

Keep a Cluster machine alive on hosts that provide an `Entity.KeepAliveHandler`. A machine whose work runs or whose timer waits now calls `Entity.keepAlive` whenever the host supports it through a handler or through the latch of a `Sharding` runner, instead of only through the latch. Before, such a host logged that it could not keep the machine alive, and its work was not recovered after a crash.
