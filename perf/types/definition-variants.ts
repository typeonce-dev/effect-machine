import { Machine } from "@typeonce/effect-machine"
import { Done, Flow, Idle, machine, Running } from "./definition-variants-control.js"

type Equal<Left, Right> = (<Type>() => Type extends Left ? 1 : 2) extends (<Type>() => Type extends Right ? 1 : 2) ?
  true :
  false
type Expect<Value extends true> = Value
type IsAny<Value> = 0 extends 1 & Value ? true : false

const complete = machine.handle({
  Flow: {
    history: {
      recent: {
        default: ({ target }) => target.Flow.from(Flow.make({}), (flow) => flow.Idle.from(Idle.make({})))
      }
    },
    states: {
      Route: {
        choice: (to) => to.local.Idle().resolve(({ target }) => target.from(Idle.make({})))
      },
      Idle: {
        on: {
          Start: (to) => to.local.Running().resolve(({ target }) => target.from(Running.make({})))
        }
      },
      Running: {
        on: {
          Finish: (to) => to.local.Done().resolve(({ event, target }) => target.from(Done.make({ value: event.value })))
        }
      },
      Done: {
        output: ({ state }) => state.value
      }
    }
  }
})

const idleOnly = machine.handle({
  Flow: {
    states: {
      Idle: {
        on: {
          Start: (to) => to.local.Running().resolve(({ target }) => target.from(Running.make({})))
        }
      }
    }
  }
})

const runningOnly = machine.handle({
  Flow: {
    states: {
      Running: {
        on: {
          Finish: (to) => to.local.Done().resolve(({ event, target }) => target.from(Done.make({ value: event.value })))
        }
      }
    }
  }
})

type ErrorIsExact = Expect<Equal<Machine.Machine.Error<typeof complete>, never>>
type ServicesAreExact = Expect<Equal<Machine.Machine.Services<typeof complete>, never>>
type OutputIsExact = Expect<Equal<Machine.Machine.Output<typeof complete>, string>>
type EveryStateIsHandled = Expect<Equal<Machine.Machine.UnhandledStates<typeof complete>, never>>
type ErrorIsNotAny = Expect<Equal<IsAny<Machine.Machine.Error<typeof complete>>, false>>
type ServicesAreNotAny = Expect<Equal<IsAny<Machine.Machine.Services<typeof complete>>, false>>

void idleOnly
void runningOnly
void Machine.planInitial(complete)
export type { ErrorIsExact, ErrorIsNotAny, EveryStateIsHandled, OutputIsExact, ServicesAreExact, ServicesAreNotAny }
