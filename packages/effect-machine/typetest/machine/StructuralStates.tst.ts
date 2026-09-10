import { type Option, Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"
class Loading extends Schema.TaggedClass<Loading>("StructuralTypeLoading")("Loading", {
  url: Schema.String
}) {}
class Ready extends Schema.TaggedClass<Ready>("StructuralTypeReady")("Ready", {
  duration: Schema.Number
}) {}
class Playing extends Schema.TaggedClass<Playing>("StructuralTypePlaying")("Playing", {
  position: Schema.Number
}) {}
class Audible extends Schema.TaggedClass<Audible>("StructuralTypeAudible")("Audible", {
  volume: Schema.Number
}) {}
class Muted extends Schema.TaggedClass<Muted>("StructuralTypeMuted")("Muted", {
  volume: Schema.Number
}) {}
class Select extends Schema.TaggedClass<Select>("StructuralTypeSelect")("Select", {
  url: Schema.String
}) {}
class Loaded extends Schema.TaggedClass<Loaded>("StructuralTypeLoaded")("Loaded", {
  duration: Schema.Number
}) {}
class Play extends Schema.TaggedClass<Play>("StructuralTypePlay")("Play", {}) {}
const States = Machine.state({
  states: {
    player: {
      type: "parallel",
      states: {
        transport: {
          states: {
            Empty: {},
            Loading,
            Ready: {
              schema: Ready,
              states: {
                Paused: {},
                Playing
              }
            }
          }
        },
        settings: {
          states: { Audible, Muted }
        }
      }
    }
  }
})
describe("structural active state types", () => {
  it("separates active, valued, and structural identifiers", () => {
    expect<
      Machine.Machine.ValuedStateIdentifier<{
        readonly "": typeof States.node
      }>
    >().type.toBe<
      | "player.transport.Loading"
      | "player.transport.Ready"
      | "player.transport.Ready.Playing"
      | "player.settings.Audible"
      | "player.settings.Muted"
    >()
    expect<
      Machine.Machine.StructuralStateIdentifier<{
        readonly "": typeof States.node
      }>
    >().type.toBe<
      | ""
      | "player"
      | "player.transport"
      | "player.transport.Empty"
      | "player.transport.Ready.Paused"
      | "player.settings"
    >()
  })
  it("requires values only for schema-backed snapshot builders", () => {
    const target = null as unknown as Machine.Machine.HistoryDefaultTargetBuilder<
      { readonly "": typeof States.node },
      ""
    >
    expect(target).type.not.toBeCallableWith({})
    expect(target).type.not.toBeCallableWith({ data: {}, states: { player: {} } })
    type Tree = Parameters<typeof target>[0]
    const valid = {
      states: {
        player: {
          states: {
            transport: { states: { Empty: {} } },
            settings: { states: { Audible: { data: { volume: 1 } } } }
          }
        }
      }
    } satisfies Tree
    expect(target).type.toBeCallableWith(valid)
    expect(target).type.not.toBeCallableWith({
      states: {
        player: {
          states: {
            transport: { states: { Empty: {} } }
          }
        }
      }
    })
    expect(target).type.not.toBeCallableWith({
      states: {
        player: {
          states: {
            transport: { states: { Empty: { data: {} } } },
            settings: { states: { Audible: {} } }
          }
        }
      }
    })
    target({
      states: {
        player: {
          states: { transport: { states: { Empty: {} } }, settings: { states: { Audible: { data: { volume: 1 } } } } }
        }
      }
    })
  })
  it("restricts value access while retaining structural snapshot queries", () => {
    type Snapshot = Machine.Snapshot<typeof States>
    const snapshot = null as unknown as Snapshot
    expect(States.get(snapshot, "player.transport.Loading")).type.toBe<Option.Option<Loading>>()
    expect(States.get).type.not.toBeCallableWith(snapshot, "player")
    expect(States.get).type.not.toBeCallableWith(snapshot, "player.transport.Empty")
    expect(States.getWithParents).type.not.toBeCallableWith(snapshot, "player.transport")
    expect(States.matches).type.toBeCallableWith(snapshot, "player")
    expect(States.matches).type.toBeCallableWith(snapshot, "player.transport.Empty")
    expect(States.getSnapshot).type.toBeCallableWith(snapshot, "player.transport")
    expect(States.getSnapshot(snapshot, "player.transport")).type.toBe<
      Option.Option<
        Machine.Machine.SnapshotByIdentifier<{
          readonly "": typeof States.node
        }, "player.transport">
      >
    >()
  })
  it("types structural handler contexts and targets without fake values", () => {
    const targets1 = Machine.targets(States)
    Machine.make({
      branches: {
        transition1: { destination: { target: targets1.root.player.transport.Ready } },
        transition2: { destination: { target: targets1.root.player.transport.Ready } }
      },
      root: States,
      events: Machine.eventsFromSchemas(Select, Loaded, Play)
    }).handle({
      initial: {
        target: Machine.targets(States).root.player
      },
      states: {
        player: {
          states: {
            transport: {
              initial: {
                target: Machine.targets(States).root.player.transport.Empty
              },
              states: {
                Empty: {
                  entry: ({ state }) => {
                    expect(state).type.toBe<undefined>()
                  },
                  on: {
                    Select: {
                      target: targets1.root.player.transport.Loading,
                      data: ({ containingState, ancestors, state }) => {
                        expect(state).type.toBe<undefined>()
                        expect(containingState).type.toBe<undefined>()
                        expect(ancestors).type.toBe<{}>()
                        return { url: "/song.mp3" }
                      }
                    }
                  }
                },
                Loading: {
                  on: {
                    Loaded: {
                      branches: "transition1",
                      resolve: ({ event, select: { destination: target } }) =>
                        target({ data: { duration: event.duration }, states: { Paused: {} } })
                    }
                  }
                },
                Ready: {
                  initial: {
                    target: Machine.targets(States).root.player.transport.Ready.Paused
                  },
                  states: {
                    Paused: {
                      on: {
                        Play: {
                          branches: "transition2",
                          resolve: ({ containingState, ancestors, state, select: { destination: target } }) => {
                            expect(target).type.not.toBeAssignableTo<() => unknown>()
                            expect(state).type.toBe<undefined>()
                            expect(containingState).type.toBe<Ready>()
                            expect(ancestors).type.toBe<{
                              readonly "player.transport.Ready": Ready
                            }>()
                            return target({
                              data: { duration: containingState.duration },
                              states: { Playing: { data: { position: 0 } } }
                            })
                          }
                        }
                      }
                    },
                    Playing: {}
                  }
                }
              }
            },
            settings: {
              initial: {
                target: Machine.targets(States).root.player.settings.Audible,
                data: { volume: 1 }
              },
              states: { Audible: {}, Muted: {} }
            }
          }
        }
      }
    })
  })
  it("rejects malformed structural declarations", () => {
    expect(Machine.state).type.not.toBeCallableWith({
      initial: "invalid",
      states: {
        invalid: { states: { child: {} } }
      }
    })
    expect(Machine.state).type.not.toBeCallableWith({
      initial: "invalid",
      states: {
        invalid: { type: "parallel" }
      }
    })
    expect(Machine.state).type.not.toBeCallableWith({
      initial: "invalid",
      states: {
        invalid: { schema: undefined }
      }
    })
  })
})
