---
"@typeonce/effect-machine": patch
---

Separate the public Machine, MachineTest, AtomMachine, and ClusterMachine contracts from their internal implementations. Enforce designated implementation seams and explicit public function signatures through the architecture check without changing the package API.
