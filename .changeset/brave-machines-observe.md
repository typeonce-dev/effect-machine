---
"@typeonce/effect-machine": minor
---

Add an Effect-native `@typeonce/effect-machine/testing` entrypoint with schema-derived scenarios, replayable planner traces, independent statechart law and finite-model verification for compound, parallel, and history states, trace coverage, observed Effect graphs, and live runtime command models.

Expose retained planner transition evidence and correct reentry boundaries, simultaneous parallel target application, and recorded nested-history restoration through inactive ancestors.

Model finite transitions through one discriminated `event | always | done` trigger representation, with independent stabilization, completion ordering, cycle detection, generated mixed-trigger models, managed-runtime differential checks, and activity-lifecycle command verification. Hand-authored finite models now migrate event transitions from `{ source, event, ... }` to `{ source, trigger: { type: "event", event }, ... }`.
