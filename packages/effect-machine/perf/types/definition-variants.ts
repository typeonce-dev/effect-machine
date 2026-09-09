import { Machine } from "../../dist/index.js"
import { Done, Flow, Idle, machine, Running, States } from "./definition-variants-control.js"
type Equal<Left, Right> = (<Type>() => Type extends Left ? 1 : 2) extends (<Type>() => Type extends Right ? 1 : 2)
  ? true
  : false
type Expect<Value extends true> = Value
type IsAny<Value> = 0 extends 1 & Value ? true : false
const targets = Machine.targets(States)
const complete = machine.handle({
  initial: { target: targets.root.Flow },
  states: {
    Flow: {
      initial: { target: targets.root.Flow.Idle },
      history: {
        recent: {
          default: ({ target }) =>
            target.from((tree) => tree.Flow.from(Flow.make({}), (flow) => flow.Idle.from(Idle.make({}))))
        }
      },
      states: {
        Route: {
          choice: { target: targets.root.Flow.Idle }
        },
        Idle: {
          on: {
            Start: { target: targets.root.Flow.Running }
          }
        },
        Running: {
          on: {
            Finish: { target: targets.root.Flow.Done, data: ({ event }) => ({ value: event.value }) }
          }
        },
        Done: {
          output: ({ state }) => state.value
        }
      }
    }
  }
})
const idleOnly = machine.handle({
  initial: { target: targets.root.Flow },
  states: {
    Flow: {
      initial: { target: targets.root.Flow.Idle },
      states: {
        Idle: {
          on: {
            Start: { target: targets.root.Flow.Running }
          }
        }
      }
    }
  }
})
const runningOnly = machine.handle({
  initial: { target: targets.root.Flow },
  states: {
    Flow: {
      initial: { target: targets.root.Flow.Idle },
      states: {
        Running: {
          on: {
            Finish: { target: targets.root.Flow.Done, data: ({ event }) => ({ value: event.value }) }
          }
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
