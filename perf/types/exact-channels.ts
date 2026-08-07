import { Machine } from "@typeonce/effect-machine"
import { Context, Data, Effect } from "effect"
import {
  Done,
  InitialFailure,
  InitialService,
  Loaded,
  machine,
  Notice,
  Start,
  States
} from "./exact-channels-control.js"

type Equal<Left, Right> = (<Type>() => Type extends Left ? 1 : 2) extends (<Type>() => Type extends Right ? 1 : 2) ?
  true :
  false
type Expect<Value extends true> = Value
type IsAny<Value> = 0 extends 1 & Value ? true : false

export class RuntimeService extends Context.Service<RuntimeService, string>()("perf/channels/RuntimeService") {}
export class ActionService extends Context.Service<ActionService, string>()("perf/channels/ActionService") {}
export class RuntimeFailure extends Data.TaggedError("RuntimeFailure")<{}> {}
export class ActionFailure extends Data.TaggedError("ActionFailure")<{}> {}

const complete = machine.handle({
  Idle: {
    entry: () =>
      Machine.action(
        Effect.flatMap(ActionService, () => Math.random() > 2 ? Effect.fail(new ActionFailure()) : Effect.void)
      ),
    on: {
      Start: ({ event, target }) =>
        Effect.flatMap(RuntimeService, () =>
          Math.random() > 2
            ? Effect.fail(new RuntimeFailure())
            : Effect.succeed(target.full.Done(Done.make({ value: event.value })))),
      Loaded: ({ event, target }) => target.full.Done(Done.make({ value: event.value }))
    }
  },
  Done: {
    output: ({ state }) => state.value
  }
})

type InputIsExact = Expect<Equal<Machine.Machine.Input<typeof complete>["Type"], { readonly seed: number }>>
type InputEventIsExact = Expect<Equal<Machine.Machine.InputEvent<typeof complete>, typeof Start.Type>>
type EventIsExact = Expect<Equal<Machine.Machine.Event<typeof complete>, typeof Start.Type | typeof Loaded.Type>>
type EmitIsExact = Expect<Equal<Machine.Machine.Emit<typeof complete>, typeof Notice.Type>>
type InitialErrorIsExact = Expect<Equal<Machine.Machine.InitialError<typeof complete>, InitialFailure>>
type InitialServicesAreExact = Expect<Equal<Machine.Machine.InitialServices<typeof complete>, InitialService>>
type ErrorIsExact = Expect<Equal<Machine.Machine.Error<typeof complete>, RuntimeFailure>>
type ServicesAreExact = Expect<
  Equal<
    Machine.Machine.Services<typeof complete>,
    RuntimeService | Machine.ActionRequirement<ActionFailure, ActionService>
  >
>
type OutputIsExact = Expect<Equal<Machine.Machine.Output<typeof complete>, string>>
type OutputStatesAreExact = Expect<Equal<Machine.Machine.OutputStates<typeof complete>, "Done">>
type ErrorIsNotAny = Expect<Equal<IsAny<Machine.Machine.Error<typeof complete>>, false>>
type ServicesAreNotAny = Expect<Equal<IsAny<Machine.Machine.Services<typeof complete>>, false>>
type OutputIsNotAny = Expect<Equal<IsAny<Machine.Machine.Output<typeof complete>>, false>>

void States
void Machine.planInitial(complete, { seed: 1 })
void Machine.start(complete, { seed: 1 })
export type {
  EmitIsExact,
  ErrorIsExact,
  ErrorIsNotAny,
  EventIsExact,
  InitialErrorIsExact,
  InitialServicesAreExact,
  InputEventIsExact,
  InputIsExact,
  OutputIsExact,
  OutputIsNotAny,
  OutputStatesAreExact,
  ServicesAreExact,
  ServicesAreNotAny
}
