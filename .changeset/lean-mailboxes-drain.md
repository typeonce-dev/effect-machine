---
"@typeonce/effect-machine": patch
---

Use a compact FIFO mailbox for on-demand compiled statecharts while retaining
Effect Queue for persistent custom process logic. This reduces idle heap for
machines and invoked families while preserving FIFO delivery, terminal send
rejection, and wake-up behavior.
