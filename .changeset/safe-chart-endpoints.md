---
"@typeonce/effect-machine-devtools": patch
---

Fix devtools charts failing to render retry transitions into compound states. Route repairs preserve the direction and clearance at both ends of each transition, including straight routes that need a detour to reach a state header.

Keep the devtools platform dependencies on the supported Effect prerelease so fresh installations can start the CLI without missing-module errors.
