import { Context, Data, Effect } from "effect"
import { Machine } from "../../dist/index.js"
import { App, Editing, Editor, EditorDone, States, Sync, SyncDone, SyncIdle, Workspace } from "./composition-control.js"
type Equal<Left, Right> = (<Type>() => Type extends Left ? 1 : 2) extends (<Type>() => Type extends Right ? 1 : 2)
  ? true
  : false
type Expect<Value extends true> = Value
type IsAny<Value> = 0 extends 1 & Value ? true : false
class CompositionService extends Context.Service<CompositionService, string>()("perf/composition/CompositionService") {
}
class CompositionFailure extends Data.TaggedError("CompositionFailure")<{}> {
}
const targets = Machine.targets(States)
const machine = Machine.make({
  branches: { enter: { app: { target: targets.root.App } } },
  root: States,
  events: Machine.eventsFromSchemas()
})
const handled = machine.handle({
  initial: {
    target: Machine.targets(States).root.App,
    data: App.make({})
  },
  states: {
    App: {
      initial: {
        target: Machine.targets(States).root.App.Workspace,
        data: Workspace.make({})
      },
      states: {
        Workspace: {
          initial: { Editor: Editor.make({}), Sync: Sync.make({}) },
          history: {
            recent: {
              default: ({ target }) =>
                target({
                  states: {
                    App: {
                      data: App.make({}),
                      states: {
                        Workspace: {
                          data: Workspace.make({}),
                          states: {
                            Editor: { data: Editor.make({}), states: { Editing: { data: Editing.make({}) } } },
                            Sync: { data: Sync.make({}), states: { Idle: { data: SyncIdle.make({}) } } }
                          }
                        }
                      }
                    }
                  }
                })
            }
          },
          output: ({ outputs }) => ({
            Editor: outputs.Editor,
            Sync: outputs.Sync
          }),
          states: {
            Editor: {
              initial: {
                target: Machine.targets(States).root.App.Workspace.Editor.Editing,
                data: Editing.make({})
              },
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
              initial: {
                target: Machine.targets(States).root.App.Workspace.Sync.Idle,
                data: SyncIdle.make({})
              },
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
              select.app({
                data: App.make({}),
                states: {
                  Workspace: {
                    data: Workspace.make({}),
                    states: {
                      Editor: { data: Editor.make({}), states: { Editing: { data: Editing.make({}) } } },
                      Sync: { data: Sync.make({}), states: { Idle: { data: SyncIdle.make({}) } } }
                    }
                  }
                }
              })
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
    Machine.Machine.OutputByIdentifier<{
      readonly "": typeof States.node
    }, "App.Workspace">,
    {
      readonly Editor: string
      readonly Sync: number
    }
  >
>
type EveryStateIsHandled = Expect<Equal<Machine.Machine.UnhandledStates<typeof handled>, never>>
type ErrorIsNotAny = Expect<Equal<IsAny<Machine.Machine.Error<typeof handled>>, false>>
type ServicesAreNotAny = Expect<Equal<IsAny<Machine.Machine.Services<typeof handled>>, false>>
void EditorDone
void SyncDone
void Machine.planInitial(handled)
export type { ErrorIsExact, ErrorIsNotAny, EveryStateIsHandled, OutputIsExact, ServicesAreExact, ServicesAreNotAny }
