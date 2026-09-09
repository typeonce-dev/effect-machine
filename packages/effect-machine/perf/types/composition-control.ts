import { Schema } from "effect"
import { Machine } from "../../dist/index.js"
export const App = Schema.TaggedStruct("App", {})
export const Workspace = Schema.TaggedStruct("Workspace", {})
export const Editor = Schema.TaggedStruct("Editor", {})
export const Editing = Schema.TaggedStruct("Editing", {})
export const EditorDone = Schema.TaggedStruct("EditorDone", { value: Schema.String })
export const Sync = Schema.TaggedStruct("Sync", {})
export const SyncIdle = Schema.TaggedStruct("SyncIdle", {})
export const SyncDone = Schema.TaggedStruct("SyncDone", { value: Schema.Number })
export const WorkspaceOutput = Schema.Struct({
  Editor: Schema.String,
  Sync: Schema.Number
})
export const States = Machine.state({
  states: {
    App: {
      schema: App,
      states: {
        Workspace: {
          schema: Workspace,
          type: "parallel",
          output: WorkspaceOutput,
          states: {
            Editor: {
              schema: Editor,
              states: {
                Editing,
                Done: {
                  schema: EditorDone,
                  type: "final",
                  output: Schema.String
                }
              }
            },
            Sync: {
              schema: Sync,
              states: {
                Idle: SyncIdle,
                Done: {
                  schema: SyncDone,
                  type: "final",
                  output: Schema.Number
                }
              }
            },
            recent: {
              type: "history",
              history: "deep"
            }
          }
        },
        Route: {
          type: "choice"
        }
      }
    }
  }
})
export const machine = Machine.make({
  root: States,
  events: Machine.eventsFromSchemas()
})
