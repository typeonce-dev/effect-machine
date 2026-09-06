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
  initial: "player",
  states: {
    player: {
      type: "parallel",
      states: {
        transport: {
          initial: "Empty",
          states: {
            Empty: {},
            Loading,
            Ready: {
              schema: Ready,
              initial: "Paused",
              states: {
                Paused: {},
                Playing
              }
            }
          }
        },
        settings: {
          initial: "Audible",
          states: { Audible, Muted }
        }
      }
    }
  }
})

describe("structural active state types", () => {
  it("separates active, valued, and structural identifiers", () => {
    expect<Machine.Machine.ValuedStateIdentifier<{ readonly "": typeof States.node }>>().type.toBe<
      | "player.transport.Loading"
      | "player.transport.Ready"
      | "player.transport.Ready.Playing"
      | "player.settings.Audible"
      | "player.settings.Muted"
    >()
    expect<Machine.Machine.StructuralStateIdentifier<{ readonly "": typeof States.node }>>().type.toBe<
      | ""
      | "player"
      | "player.transport"
      | "player.transport.Empty"
      | "player.transport.Ready.Paused"
      | "player.settings"
    >()
  })

  it("requires values only for schema-backed snapshot builders", () => {
    Machine.make({
      root: States,
      events: Machine.eventsFromSchemas(),
      initialConfiguration: (root) =>
        root.resolve(({ target }) => {
          expect(target.from).type.not.toBeCallableWith({}, () => undefined)
          expect<typeof target extends (...args: ReadonlyArray<any>) => any ? true : false>().type.toBe<false>()

          type RootBuilder = Parameters<typeof target.from>[0] extends (builder: infer Builder) => unknown ? Builder
            : never
          const tree = null as unknown as RootBuilder
          type PlayerBuilder = Parameters<typeof tree.player.from>[0] extends (builder: infer Builder) => unknown
            ? Builder
            : never
          const player = null as unknown as PlayerBuilder
          expect(player.transport.from).type.not.toBeCallableWith((transport: unknown) => transport)

          type TransportBuilder = Parameters<typeof player.transport.from>[0] extends
            (builder: infer Builder) => unknown ? Builder
            : never
          const transport = null as unknown as TransportBuilder
          expect(transport.Empty.from).type.toBeCallableWith()
          expect(transport.Empty.from).type.not.toBeCallableWith({})
          type SettingsBuilder = Parameters<typeof player.settings.from>[0] extends
            (builder: infer Builder) => unknown ? Builder
            : never
          const settings = null as unknown as SettingsBuilder
          expect(settings.Audible.from).type.toBeCallableWith({ volume: 1 })
          expect(settings.Audible.from).type.not.toBeCallableWith()

          return target.from((to) =>
            to.player.from((player) =>
              player
                .transport.from((transport) => transport.Empty.from())
                .settings.from((settings) => settings.Audible.from({ volume: 1 }))
            )
          )
        })
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
      Option.Option<Machine.Machine.SnapshotByIdentifier<{ readonly "": typeof States.node }, "player.transport">>
    >()
  })

  it("types structural handler contexts and targets without fake values", () => {
    Machine.make({
      root: States,
      events: Machine.eventsFromSchemas(Select, Loaded, Play),
      initialConfiguration: (root) =>
        root.resolve(({ target }) => (target.from((to) =>
          to.player.from((player) =>
            player
              .transport.from((transport) => transport.Empty.from())
              .settings.from((settings) => settings.Audible.from({ volume: 1 }))
          )
        )))
    }).handle({
      states: {
        player: {
          states: {
            transport: {
              states: {
                Empty: {
                  entry: ({ state }) => {
                    expect(state).type.toBe<undefined>()
                  },
                  on: {
                    Select: (to) => {
                      expect(to.local).type.not.toHaveProperty("with")
                      return to.local.Loading().resolve(({ containingState, ancestors, state, target }) => {
                        expect(state).type.toBe<undefined>()
                        expect(containingState).type.toBe<undefined>()
                        expect(ancestors).type.toBe<{}>()
                        expect(target.from).type.toBeCallableWith({ url: "/song.mp3" })
                        expect(target.from).type.not.toBeCallableWith()
                        return target.from({ url: "/song.mp3" })
                      })
                    }
                  }
                },
                Loading: {
                  on: {
                    Loaded: (to) =>
                      to.local.Ready().resolve(({ event, target }) =>
                        target.from(
                          { duration: event.duration },
                          (ready) => ready.Paused.from()
                        )
                      )
                  }
                },
                Ready: {
                  states: {
                    Paused: {
                      on: {
                        Play: (to) =>
                          to.local.with.resolve(({ containingState, ancestors, state, target }) => {
                            expect(to.local.with).type.not.toBeAssignableTo<() => unknown>()
                            expect(state).type.toBe<undefined>()
                            expect(containingState).type.toBe<Ready>()
                            expect(ancestors).type.toBe<{ readonly "player.transport.Ready": Ready }>()
                            return target.from(
                              { duration: containingState.duration },
                              (ready) => ready.Playing.from({ position: 0 })
                            )
                          })
                      }
                    }
                  }
                }
              }
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
