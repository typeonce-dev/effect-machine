---
"@typeonce/effect-machine": patch
"@typeonce/effect-machine-react": patch
---

Serve referentially stable server values from machine atoms, so React no longer warns that `getServerSnapshot` should be cached while hydrating `MachineState` or other hooks that read machine atoms.
