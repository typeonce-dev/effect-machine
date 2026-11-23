---
"@typeonce/effect-machine": minor
---

The types of `LocalMachine`, `AtomMachine`, and `ClusterMachine` now say only what can happen. Transitions, actions, and initial states are synchronous, so the types that described effects inside them are removed. Runtime behavior does not change.

Most were always `never`, so delete the mention:

- `Machine.ActionError`, `Machine.ActionServices`, and `Machine.ActionRequirement`. Replace `Machine.PlanningServices<R>` with `R`.
- `Machine.Machine.InitialError` and `Machine.Machine.InitialServices`, with the `InitialE` and `InitialR` type parameters of `Machine.Machine`, `Machine.Definition`, `Machine.make`, and every API generic over a machine. Delete the seventh and eighth type arguments of a written-out `Machine.Machine<...>`, and the fourth and fifth of `Machine.Definition<...>`.
- The `E` and `R` type parameters of `Machine.Machine.HandlerContext`, `HandlerResult`, `InitialResult`, and `StateActionResult`, and the `Requirements` type parameter of `MachineTest.Microstep`. Delete these arguments. A `HandlerContext` that still passes `never, never` compiles with another meaning.

The others described values that no API produces or accepts:

- `Machine.Runtime` and `Machine.Runtime.Requirement`. Handlers raise and emit events with `Machine.Enqueue`.
- `Machine.Machine.AnyStateConfig`, `StateConfig`, `ChoiceStateConfig`, and `EventHandlerMap`. Use `Machine.Machine.StateHandler`.
- `Machine.Machine.InvokeOwned` and `InvokeSource`. Use `Machine.Machine.Invocation`.
- `Machine.Machine.EventTransitionReturn`, `EventHandlerReturn`, `AlwaysReturn`, `DoneReturn`, `ChoiceReturn`, and `InvokeOutcomeReturn`. They have no replacement.

`LocalMachine.RequiredServices<R>`, which replaces `Machine.ExecutionServices<R>`, is `Exclude<R, Machine.MachineRuntime>`. The errors of a machine whose requirements are `any` are listed exactly instead of as `unknown`.
