import { Context, Data, Effect } from "effect"
import { Machine } from "../../dist/index.js"
import { App, Editing, Editor, EditorDone, States, Sync, SyncDone, SyncIdle, Workspace } from "./composition-control.js"

type Equal<Left, Right> = (<Type>() => Type extends Left ? 1 : 2) extends (<Type>() => Type extends Right ? 1 : 2) ?
  true :
  false
type Expect<Value extends true> = Value
type IsAny<Value> = 0 extends 1 & Value ? true : false

class CompositionService extends Context.Service<CompositionService, string>()(
  "perf/composition/CompositionService"
) {}
class CompositionFailure extends Data.TaggedError("CompositionFailure")<{}> {}

const targets = Machine.targets(States)
const machine = Machine.make({
  branches: { enter: { app: { target: targets.root.App } } },

  root: States,
  events: Machine.eventsFromSchemas(),
  initialConfiguration: (root) =>
    root.resolve(({ target }) =>
      target.from((to) =>
        to.App.from(App.make({}), (app) =>
          app.Workspace.from(
            Workspace.make({}),
            (workspace) =>
              workspace
                .Editor.from(Editor.make({}), (editor) => editor.Editing.from(Editing.make({})))
                .Sync.from(Sync.make({}), (sync) => sync.Idle.from(SyncIdle.make({})))
          ))
      )
    )
})

const handled = machine.handle({
  states: {
    App: {
      states: {
        Workspace: {
          history: {
            recent: {
              default: ({ target }) =>
                target.from((tree) =>
                  tree.App.from(App.make({}), (app) =>
                    app.Workspace.from(
                      Workspace.make({}),
                      (workspace) =>
                        workspace
                          .Editor.from(Editor.make({}), (editor) => editor.Editing.from(Editing.make({})))
                          .Sync.from(Sync.make({}), (sync) => sync.Idle.from(SyncIdle.make({})))
                    ))
                )
            }
          },
          output: ({ outputs }) => ({
            Editor: outputs.Editor,
            Sync: outputs.Sync
          }),
          states: {
            Editor: {
              states: {
                Editing: {
                  entry: () => {}
                },
                Done: {
                  output: ({ state }) => state.value
                }
              }
            },
            Sync: {
              states: {
                Idle: {},
                Done: {
                  output: ({ state }) => state.value
                }
              }
            }
          }
        },
        Route: {
          choice: {
            branches: "enter",
            resolve: ({ select }) =>
              select.app.from(App.make({}), (app) =>
                app.Workspace.from(
                  Workspace.make({}),
                  (workspace) =>
                    workspace
                      .Editor.from(Editor.make({}), (editor) => editor.Editing.from(Editing.make({})))
                      .Sync.from(Sync.make({}), (sync) => sync.Idle.from(SyncIdle.make({})))
                ))
          }
        }
      }
    }
  }
})

type ErrorIsExact = Expect<Equal<Machine.Machine.Error<typeof handled>, never>>
type ServicesAreExact = Expect<Equal<Machine.Machine.Services<typeof handled>, never>>
type OutputIsExact = Expect<
  Equal<
    Machine.Machine.OutputByIdentifier<{ readonly "": typeof States.node }, "App.Workspace">,
    { readonly Editor: string; readonly Sync: number }
  >
>
type EveryStateIsHandled = Expect<Equal<Machine.Machine.UnhandledStates<typeof handled>, never>>
type ErrorIsNotAny = Expect<Equal<IsAny<Machine.Machine.Error<typeof handled>>, false>>
type ServicesAreNotAny = Expect<Equal<IsAny<Machine.Machine.Services<typeof handled>>, false>>

void EditorDone
void SyncDone
void Machine.planInitial(handled)
export type { ErrorIsExact, ErrorIsNotAny, EveryStateIsHandled, OutputIsExact, ServicesAreExact, ServicesAreNotAny }
