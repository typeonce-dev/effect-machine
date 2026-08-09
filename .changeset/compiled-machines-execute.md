---
"@typeonce/effect-machine": patch
---

Compile reusable statechart execution metadata and run eligible flat machines through a synchronous specialized planner inside the compact Effect process kernel. This removes per-event Effect wrappers and repeated topology construction while preserving schema validation, raised-event stabilization, lifecycle ordering, observation, interruption, invoked children, and the public planning and machine APIs.
