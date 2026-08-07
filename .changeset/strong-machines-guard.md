---
"@typeonce/effect-machine": patch
---

Harden machine execution and definitions while preserving the existing Effect-native API. Self-stop now uses supervisor-owned terminal arbitration without initialization or worker deadlocks; execution adapters consistently reject incomplete output, history, and choice implementations; finite-union event tags narrow correctly; and machine guards verify the runtime brand value.

State definitions now reject unknown node properties and unsafe state keys at compile time and runtime with path-local diagnostics. Add deterministic lifecycle, adversarial snapshot-codec, type-performance, activity-lifecycle, and planner-versus-runtime verification coverage.
