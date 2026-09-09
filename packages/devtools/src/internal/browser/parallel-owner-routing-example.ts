import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"
class Print extends Schema.TaggedClass<Print>("ParallelOwnerPrint")("Print", {}) {
}
class Options extends Schema.TaggedClass<Options>("ParallelOwnerOptions")("Options", {}) {
}
class OptionsReady extends Schema.TaggedClass<OptionsReady>("ParallelOwnerOptionsReady")("Ready", {}) {
}
class Operation extends Schema.TaggedClass<Operation>("ParallelOwnerOperation")("Operation", {}) {
}
class Active extends Schema.TaggedClass<Active>("ParallelOwnerActive")("Active", {}) {
}
class Printing extends Schema.TaggedClass<Printing>("ParallelOwnerPrinting")("Printing", {}) {
}
class ChildIdle extends Schema.TaggedClass<ChildIdle>("ParallelOwnerChildIdle")("Idle", {}) {
}
class ChildSignal extends Schema.TaggedClass<ChildSignal>("ParallelOwnerChildSignal")("ChildSignal", {}) {
}
class PrintRequested extends Schema.TaggedClass<PrintRequested>("ParallelOwnerPrintRequested")("PrintRequested", {}) {
}
const ChildParentEvents = Machine.eventsFromSchemas(ChildSignal)
const ParallelOwnerChildStates = Machine.state({ states: { Idle: ChildIdle } })
export const parallelOwnerRoutingChildMachine = Machine.make({
  effects: {
    source1: ({ parent }: Machine.Machine.InvokeContext<
      {
        readonly "": {
          readonly initial: "Idle"
          readonly states: {
            readonly Idle: typeof ChildIdle
          }
        } & {
          readonly "~effect/Machine/ExplicitInitial": true
        }
      },
      readonly [],
      readonly [],
      "Idle",
      readonly [],
      Machine.Machine.ParentEventSchemas<
        "required",
        readonly [
          typeof ChildSignal
        ]
      >
    >) => parent.send(ChildParentEvents.ChildSignal())
  },
  id: "parallel-owner-routing-child",
  root: ParallelOwnerChildStates,
  events: Machine.eventsFromSchemas(),
  parent: Machine.parent(ChildParentEvents)
}).handle({
  initial: {
    target: Machine.targets(ParallelOwnerChildStates).root.Idle,
    decoded: true,
    data: new ChildIdle({})
  },
  states: {
    Idle: {
      invoke: {
        src: "source1",
        id: "signal-parent",
        input: (context) => context,
        onDone: { none: true },
        onFailure: { none: true }
      }
    }
  }
})
const ParallelOwnerChild = Machine.child("parallel-owner-child", parallelOwnerRoutingChildMachine)
const ParallelOwnerStates = Machine.state({
  states: {
    Print: {
      schema: Print,
      type: "parallel",
      states: {
        Options: {
          schema: Options,
          states: {
            Ready: OptionsReady
          }
        },
        Operation: {
          schema: Operation,
          states: {
            Active,
            Printing
          }
        }
      }
    }
  }
})
const targets2 = Machine.targets(ParallelOwnerStates)
export const parallelOwnerRoutingMachine = Machine.make({
  children: { source1: ParallelOwnerChild },
  id: "parallel-owner-routing",
  root: ParallelOwnerStates,
  events: Machine.eventsFromSchemas(PrintRequested, ChildParentEvents)
}).handle({
  initial: {
    target: Machine.targets(ParallelOwnerStates).root.Print,
    decoded: true,
    data: new Print({})
  },
  states: {
    Print: {
      initial: { Options: ({}) => ({}), Operation: ({}) => ({}) },
      invoke: {
        src: "source1",
        onFailure: { target: targets2.root.Print.Operation.Active, decoded: true, data: () => (new Active({})) }
      },
      on: {
        PrintRequested: {
          target: targets2.root.Print.Operation.Printing,
          decoded: true,
          data: () => (new Printing({}))
        }
      },
      states: {
        Options: {
          initial: {
            target: Machine.targets(ParallelOwnerStates).root.Print.Options.Ready,
            data: ({}) => ({})
          },
          states: {
            Ready: {}
          }
        },
        Operation: {
          initial: {
            target: Machine.targets(ParallelOwnerStates).root.Print.Operation.Active,
            data: ({}) => ({})
          },
          states: {
            Active: {},
            Printing: {}
          }
        }
      }
    }
  }
})
