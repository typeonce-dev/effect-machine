---
"@typeonce/effect-machine": patch
---

Skip child-registry allocation for statecharts that cannot invoke child processes, while preserving empty child lookup, observation, send, and stop behavior.
