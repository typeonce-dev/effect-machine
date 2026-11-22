---
"@typeonce/effect-machine": minor
---

Export the `Machine.MachineRuntime` type, the service required by `Machine.sendTo`, `Machine.stopChild`, and `Machine.spawn`. Exported helpers built from these operations now emit declarations with `declaration: true`, whether their type is inferred or annotated:

```ts
export const stop = <Event>(
  child: Machine.ChildAddress<Event>
): Effect.Effect<void, never, Machine.MachineRuntime> => Machine.stopChild(child)
```

Only the type is public; the service is still provided by the running machine. `MachineTest` also exports `CausalRuntimeCommandAttempt` and `FiniteChoiceState`, the types of `CausalRuntimeCommandFailure.attempted` and the choice member of `FiniteState`, so values that use them can be named too.
