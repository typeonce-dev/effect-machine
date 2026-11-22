---
"@typeonce/effect-machine": minor
---

`MachineTest` now has one name for each enqueue-oriented runtime API. The deprecated `runRuntimeCommands` and `formatRuntimeTranscript` are removed: use `runEnqueuedCommands` and `formatEnqueuedTranscript`. The duplicate type names `RuntimeModelStep`, `RuntimeModelOptions`, `RuntimeInspectionContext`, `RuntimeAssertionContext`, `RuntimeCommandActual`, `RuntimeCommandRecord`, and `RuntimeTranscript` are removed: use the same types under their `Enqueued` names, such as `EnqueuedRuntimeModelOptions` and `EnqueuedRuntimeTranscript`.

Child states can now be named `initial` or `with`. Both names were reserved for target builders that no longer exist. `Machine.initialDefinition(machine).selection.kind` is now typed as `"initial"`, the only value it returns.

Unused types that no API accepts or returns are removed: `Machine.Machine.ChoiceResult`, `InitialReturn`, `TargetSelection`, `HandlerEffect`, `HandlerError`, `HandlerServices`, `InvokeEmits`, `FinalOutputReturn`, `InvokeTransition`, and `StateConfigs`, `Machine.Runtime.Protocol`, `Machine.Runtime.Events`, and `Machine.Runtime.Emits`, and `Machine.SpawnIdOptions`. Use `Machine.SpawnOptions` with an `id` in place of `SpawnIdOptions`, and `Effect.Error` or `Effect.Services` in place of the handler extractors.
