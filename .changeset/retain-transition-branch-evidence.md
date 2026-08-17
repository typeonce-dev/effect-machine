---
"@typeonce/effect-machine": minor
---

Retain exact static and runtime transition evidence for testing and visualization. Transition branch inspection now includes the selected target kind and scope, retained planner transitions identify the zero-based branch that executed, and `Machine.initialDefinition` exposes the root startup selection without executing its resolver.

Use `branchIndex` to associate a retained transition with the corresponding entry in `Machine.transitionDefinitions(machine).branches`. Direct transitions use index `0`; conditional cases retain their declaration index and `otherwise` follows the final case.
