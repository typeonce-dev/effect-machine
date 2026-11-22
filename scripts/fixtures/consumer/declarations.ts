import { Machine } from "@typeonce/effect-machine"
import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { MachineTest } from "@typeonce/effect-machine/testing"
import { Effect, Schema } from "effect"

// Exported values must emit declarations that name only public types, whether
// the type is inferred or written by hand.

export const stopInferred = <Event>(child: Machine.ChildAddress<Event>) => Machine.stopChild(child)

export const stopAnnotated = <Event>(
  child: Machine.ChildAddress<Event>
): Effect.Effect<void, never, Machine.MachineRuntime> => Machine.stopChild(child)

export const sendInferred = (child: Machine.ChildAddress<number>, event: number) => Machine.sendTo(child, event)

export const sendAnnotated = (
  child: Machine.ChildAddress<number>,
  event: number
): Effect.Effect<void, Machine.StoppedError, Machine.MachineRuntime> => Machine.sendTo(child, event)

export const spawnInferred = Machine.spawn(Machine.logic({ initial: 0, run: () => Effect.never }), { id: "worker" })

export const choiceState = (state: MachineTest.FiniteState) => state._tag === "Choice" ? state : undefined

export const attemptedCommand = (failure: MachineTest.CausalRuntimeCommandFailure) => failure.attempted

// Declarations of exported event protocols, machines with history and parent
// events, their atoms and selectors, and standalone handler helpers name the
// public `Machine.Machine` members they are built from, so those members must
// stay exported.

const Workspace = Machine.state({
  fields: { session: Schema.String },
  states: {
    Closed: {},
    Open: {
      states: {
        Editing: { fields: { draft: Schema.String } },
        Reviewing: {},
        Resume: { type: "history" }
      }
    }
  }
})

export const WorkspaceEvents = Machine.events({ Open: {}, Close: {}, Edit: { draft: Schema.String } })

export const resumeFallback = (
  target: Machine.Machine.HistoryDefaultTargetBuilder<{ readonly "": typeof Workspace.node }, "Open">
) => target({ data: { session: "fallback" }, states: { Open: { states: { Reviewing: {} } } } })

export const workspace = Machine.make({ root: Workspace, events: WorkspaceEvents }).handle({
  root: () => ({ session: "initial" }),
  initial: { target: "Closed" },
  states: {
    Closed: { on: { Open: { history: "Open.Resume" } } },
    Open: {
      initial: { target: "Open.Reviewing" },
      history: { Resume: { default: ({ target }) => resumeFallback(target) } },
      on: { Close: { target: "Closed" } },
      states: {
        Editing: {},
        Reviewing: { on: { Edit: { target: "Open.Editing", data: ({ event }) => ({ draft: event.draft }) } } }
      }
    }
  }
})

export const workspaceAtoms = AtomMachine.make(workspace)

export const editingWorkspace = AtomMachine.selectSnapshot(workspaceAtoms, "Open.Editing")

export const ReviewerEvents = Machine.events({ Approved: {} })

export const reviewer = Machine.make({
  root: Machine.state({ states: { Reviewing: {}, Done: { type: "final" } } }),
  events: Machine.events({ Approve: {} }),
  parent: Machine.parent(ReviewerEvents)
}).handle({
  initial: { target: "Reviewing" },
  states: {
    Reviewing: {
      on: {
        Approve: {
          branches: [{ target: "Done" }],
          resolve: ({ parent, select }, enqueue) => {
            enqueue.sendTo(parent, ReviewerEvents.Approved())
            return select.target("Done")
          }
        }
      }
    },
    Done: {}
  }
})
