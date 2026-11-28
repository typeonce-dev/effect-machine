import type { Machine } from "../../src/index.js"

/**
 * The machine type an API rebuilds from the parameters of `M`. It leaves out
 * the type-only evidence that `handle` adds for `MachineTest.check`, so an API
 * that rebuilds the type returns one identical to this, and assignable to and
 * from `M`.
 */
export type Rebuilt<M extends Machine.Machine.Any> = Machine.Machine<
  Machine.Machine.States<M>,
  Machine.Machine.Events<M>,
  Machine.Machine.InputSchema<M>,
  Machine.Machine.UnhandledStates<M>,
  Machine.Machine.Error<M>,
  Machine.Machine.Services<M>,
  Machine.Machine.FinalStates<M>,
  Machine.Machine.Output<M>,
  Machine.Machine.EmittedEvents<M>,
  Machine.Machine.OutputStates<M>,
  Machine.Machine.InputEvents<M>,
  Machine.Machine.ParentEvents<M>
>
