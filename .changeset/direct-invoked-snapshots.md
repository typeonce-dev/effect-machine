---
"@typeonce/effect-machine": patch
---

Deliver invoked child snapshots directly from the child runtime, removing the replay PubSub and watcher fiber previously retained by every snapshot-mapped invocation.
