import { Machine } from "@typeonce/effect-machine"
import { Effect } from "effect"
import { Done, Loaded, machine, Notice, Start, States } from "./exact-channels-control.js"

type Equal<Left, Right> = (<Type>() => Type extends Left ? 1 : 2) extends (<Type>() => Type extends Right ? 1 : 2) ?
  true :
  false
type Expect<Value extends true> = Value
type IsAny<Value> = 0 extends 1 & Value ? true : false

const complete = machine.handle({
  Idle: {
    entry: () => {},
    on: {
      Start: (to) =>
        to.full.Done().resolve(({ event, target }, enqueue) => {
          enqueue.emit(Notice.make({ value: event.value }))
          return target.from(Done.make({ value: event.value }))
        }),
      Loaded: (to) => to.full.Done().resolve(({ event, target }) => target.from(Done.make({ value: event.value })))
    }
  },
  Done: {
    output: ({ state }) => state.value
  }
})

type InputSchemaIsExact = Expect<
  Equal<Machine.Machine.InputSchema<typeof complete>["Type"], { readonly seed: number }>
>
type InputIsExact = Expect<Equal<Machine.Machine.Input<typeof complete>, { readonly seed: number }>>
type InputEventIsExact = Expect<Equal<Machine.Machine.InputEvent<typeof complete>, typeof Start.Type>>
type EventIsExact = Expect<Equal<Machine.Machine.Event<typeof complete>, typeof Start.Type | typeof Loaded.Type>>
type EmitIsExact = Expect<Equal<Machine.Machine.Emit<typeof complete>, typeof Notice.Type>>
type InitialErrorIsExact = Expect<Equal<Machine.Machine.InitialError<typeof complete>, never>>
type InitialServicesAreExact = Expect<Equal<Machine.Machine.InitialServices<typeof complete>, never>>
type ErrorIsExact = Expect<Equal<Machine.Machine.Error<typeof complete>, never>>
type ServicesAreExact = Expect<Equal<Machine.Machine.Services<typeof complete>, never>>
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
  InputSchemaIsExact,
  OutputIsExact,
  OutputIsNotAny,
  OutputStatesAreExact,
  ServicesAreExact,
  ServicesAreNotAny
}
