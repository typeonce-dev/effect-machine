---
"@typeonce/effect-machine": patch
---

Suspend compiled statechart workers while their mailboxes are idle and start an
on-demand drain when an event arrives. This reduces retained heap for idle
machines and invoked families without changing event ordering, terminal
arbitration, or the public machine API.
