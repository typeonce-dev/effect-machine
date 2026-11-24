---
"@typeonce/effect-machine": minor
---

Let a Cluster machine leave memory while a long timer waits.

A timer that waits longer than `DurableClock.InMemoryThreshold` (one minute by default, as for workflow sleeps) no longer keeps its entity alive. The step that stores its due time also saves, in the same `MessageStorage` transaction, a message to the entity that Cluster delivers at that time through `DeliverAt`. The entity may be passivated, and the message brings it back when the timer is due, on whichever runner owns it then. The path, id, and due time of the timer name the message, so the message of a wait that ended is ignored, and saving it twice is a duplicate. A timer that never ends saves no message and keeps nothing alive. A long wait stored by an earlier version gets its message the next time its entity comes up. Shorter timers stay in memory as before. The checkpoint format is unchanged.

A long timer of an entity that left memory fires up to one `entityMessagePollInterval` after it is due.
