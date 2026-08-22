---
"@typeonce/effect-machine": minor
---

Add process-owned child machine spawning for runtime-sized child sets.

Use `Machine.childFamily(machine)` to bind a child machine once, then call
`children.spawn(Family(id), { input })` inside an invoked Effect. Successfully
started children survive owner state changes and remain addressable through
machine references and `AtomMachine` until they stop or their parent stops.

`Logic.Scope.spawn` accepts the same child descriptors for lower-level process
logic. Dynamic spawn calls retain child input, startup failure and service
inference, and check the child's declared parent protocol.
