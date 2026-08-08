import { Machine } from "@typeonce/effect-machine"
import { Context, Data, Effect } from "effect"
import {
  App,
  Editing,
  Editor,
  EditorDone,
  initialWorkspace,
  machine,
  States,
  Sync,
  SyncDone,
  SyncIdle,
  Workspace
} from "./composition-control.js"

type Equal<Left, Right> = (<Type>() => Type extends Left ? 1 : 2) extends (<Type>() => Type extends Right ? 1 : 2) ?
  true :
  false
type Expect<Value extends true> = Value
type IsAny<Value> = 0 extends 1 & Value ? true : false

class CompositionService extends Context.Service<CompositionService, string>()(
  "perf/composition/CompositionService"
) {}
class CompositionFailure extends Data.TaggedError("CompositionFailure")<{}> {}

const handled = machine.handle({
  App: {
    states: {
      Workspace: {
        history: {
          recent: {
            default: () => initialWorkspace()
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
          targets: ["App"],
          transition: ({ target }) =>
            target.full.App(App.make({}), (app) =>
              app.Workspace(
                Workspace.make({}),
                (workspace) =>
                  workspace
                    .Editor(Editor.make({}), (editor) => editor.Editing(Editing.make({})))
                    .Sync(Sync.make({}), (sync) => sync.Idle(SyncIdle.make({})))
              ))
        }
      }
    }
  }
})

type ErrorIsExact = Expect<Equal<Machine.Machine.Error<typeof handled>, never>>
type ServicesAreExact = Expect<Equal<Machine.Machine.Services<typeof handled>, never>>
type OutputIsExact = Expect<
  Equal<
    Machine.Machine.OutputByIdentifier<typeof States.states, "App.Workspace">,
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
