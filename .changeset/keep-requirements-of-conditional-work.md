---
"@typeonce/effect-machine": minor
---

A state that picks its work by a condition, such as `invoke: { src: ready ? "load" : "wait" }`, now carries the requirements of every source it can pick. Before, the choice resolved to nothing, so its services and the kinds of work that not every host runs were dropped from the machine's type.

Some machines now require a service they were silently missing, and `ClusterMachine.make` now refuses at compile time a machine whose state can pick a Stream, logic, or a child machine by a condition, instead of failing when that work starts.
