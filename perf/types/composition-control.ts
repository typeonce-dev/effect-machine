import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

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

export const States = Machine.defineStates({
  App: {
    schema: App,
    initial: "Workspace",
    states: {
      Workspace: {
        schema: Workspace,
        type: "parallel",
        output: WorkspaceOutput,
        states: {
          Editor: {
            schema: Editor,
            initial: "Editing",
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
            initial: "Idle",
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
})

export const initialWorkspace = () =>
  States.initial.App(App.make({}), (app) =>
    app.Workspace(
      Workspace.make({}),
      (workspace) =>
        workspace
          .Editor(Editor.make({}), (editor) => editor.Editing(Editing.make({})))
          .Sync(Sync.make({}), (sync) => sync.Idle(SyncIdle.make({})))
    ))

export const machine = Machine.make({
  states: States.states,
  events: Machine.events(),
  initial: initialWorkspace
})
