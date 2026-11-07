/**
 * @title Updating retained state and enqueueing commands
 *
 * `data` only ever means the target's value. `update` is a record naming the one
 * retained state it replaces. `commands` enqueues work on any plain transition.
 */
import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

export const DocumentEmitted = Machine.emittedEvents({ Saved: { revision: Schema.Number } })

export const DocumentMachine = Machine.make({
  root: Machine.state({
    states: {
      Document: {
        fields: { revision: Schema.Number },
        states: {
          Editing: {},
          Saving: { fields: { draft: Schema.String } }
        }
      }
    }
  }),
  events: Machine.events({ Change: {}, Save: { draft: Schema.String }, Saved: {} }),
  emittedEvents: DocumentEmitted
}).handle({
  initial: { target: "Document", data: { revision: 0 } },
  states: {
    Document: {
      initial: { target: "Document.Editing" },
      on: {
        // Replaces the value of Document and keeps its active child and running work.
        Change: { update: { Document: ({ state }) => ({ revision: state.revision + 1 }) } }
      },
      states: {
        Editing: {
          on: {
            // Enters a state and replaces a retained ancestor in one validated step.
            Save: {
              target: "Document.Saving",
              data: ({ event }) => ({ draft: event.draft }),
              update: { Document: ({ ancestors }) => ({ revision: ancestors.Document.revision + 1 }) }
            }
          }
        },
        Saving: {
          on: {
            Saved: {
              target: "Document.Editing",
              commands: ({ ancestors }, enqueue) =>
                enqueue.emit(DocumentEmitted.Saved({ revision: ancestors.Document.revision }))
            }
          }
        }
      }
    }
  }
})
