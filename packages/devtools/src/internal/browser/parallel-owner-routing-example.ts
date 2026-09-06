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
  id: "parallel-owner-routing-child",
  root: ParallelOwnerChildStates,
  events: Machine.eventsFromSchemas(),
  parent: Machine.parent(ChildParentEvents),
  initialConfiguration: (root) => root.resolve(({ target }) => target.from((to) => to.Idle.decoded(new ChildIdle({}))))
}).handle({
  states: {
    Idle: {
      invoke: (from) =>
        from.effect(
          "signal-parent",
          ({ parent }) => parent.send(ChildParentEvents.ChildSignal())
        ).onDone((to) => to.none).onFailure((to) => to.none)
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

export const parallelOwnerRoutingMachine = Machine.make({
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
      invoke: (from) =>
        from.child(ParallelOwnerChild).onFailure((to) =>
          to.branch.Print.Operation.Active().resolve(({ target }) => target.decoded(new Active({})))
        ),
      on: {
        PrintRequested: (to) =>
          to.branch.Print.Operation.Printing().resolve(({ target }) => target.decoded(new Printing({})))
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
