---
"@typeonce/effect-machine": minor
---

Make `MachineTest.coverage` report transition definitions and their exact branches separately. Read definition coverage through `coverage.transitions.definitions` and conditional branch coverage through `coverage.transitions.branches`.

Replace the `targetBounds` verification law group with `definitions`. The new laws validate the declared startup root, transition registration, retained `branchIndex`, and the selected branch's exact target kind and scope.
