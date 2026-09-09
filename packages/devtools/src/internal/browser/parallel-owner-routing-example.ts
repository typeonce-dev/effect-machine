import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

class Print extends Schema.TaggedClass<Print>("ParallelOwnerPrint")("Print", {}) {}
class Options extends Schema.TaggedClass<Options>("ParallelOwnerOptions")("Options", {}) {}
class OptionsReady extends Schema.TaggedClass<OptionsReady>("ParallelOwnerOptionsReady")("Ready", {}) {}
class Operation extends Schema.TaggedClass<Operation>("ParallelOwnerOperation")("Operation", {}) {}
class Active extends Schema.TaggedClass<Active>("ParallelOwnerActive")("Active", {}) {}
class Printing extends Schema.TaggedClass<Printing>("ParallelOwnerPrinting")("Printing", {}) {}
class ChildIdle extends Schema.TaggedClass<ChildIdle>("ParallelOwnerChildIdle")("Idle", {}) {}
class ChildSignal extends Schema.TaggedClass<ChildSignal>("ParallelOwnerChildSignal")("ChildSignal", {}) {}
class PrintRequested extends Schema.TaggedClass<PrintRequested>("ParallelOwnerPrintRequested")(
  "PrintRequested",
  {}
) {}

const ChildParentEvents = Machine.eventsFromSchemas(ChildSignal)
const ParallelOwnerChildStates = Machine.state({ initial: "Idle", states: { Idle: ChildIdle } })

export const parallelOwnerRoutingChildMachine = Machine.make({
  effects: {
    source1: ({
      parent
    }: Machine.Machine.InvokeContext<
      {
        readonly "": { readonly initial: "Idle"; readonly states: { readonly Idle: typeof ChildIdle } } & {
          readonly "~effect/Machine/ExplicitInitial": true
        }
      },
      readonly [],
      readonly [],
      "Idle",
      readonly [],
      Machine.Machine.ParentEventSchemas<"required", readonly [typeof ChildSignal]>
    >) => parent.send(ChildParentEvents.ChildSignal())
  },

  id: "parallel-owner-routing-child",
  root: ParallelOwnerChildStates,
  events: Machine.eventsFromSchemas(),
  parent: Machine.parent(ChildParentEvents),
  initialConfiguration: (root) => root.resolve(({ target }) => target.from((to) => to.Idle.decoded(new ChildIdle({}))))
}).handle({
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
  initial: "Print",
  states: {
    Print: {
      schema: Print,
      type: "parallel",
      states: {
        Options: {
          schema: Options,
          initial: "Ready",
          states: {
            Ready: OptionsReady
          }
        },
        Operation: {
          schema: Operation,
          initial: "Active",
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
  events: Machine.eventsFromSchemas(PrintRequested, ChildParentEvents),
  initialConfiguration: (root) =>
    root.resolve(({ target }) =>
      target.from((to) =>
        to.Print.decoded(
          new Print({}),
          (print) =>
            print.Options.decoded(new Options({}), (options) => options.Ready.decoded(new OptionsReady({}))).Operation
              .decoded(new Operation({}), (operation) => operation.Active.decoded(new Active({})))
        )
      )
    )
}).handle({
  states: {
    Print: {
      initialize: ({ builder }) => builder.Options.from({}).Operation.from({}),
      invoke: {
        src: "source1",
        onFailure: { target: targets2.root.Print.Operation.Active, decoded: () => (new Active({})) }
      },
      on: {
        PrintRequested: { target: targets2.root.Print.Operation.Printing, decoded: () => (new Printing({})) }
      },
      states: {
        Options: {
          initialize: ({ builder }) => builder.from({})
        },
        Operation: {
          initialize: ({ builder }) => builder.from({})
        }
      }
    }
  }
})
