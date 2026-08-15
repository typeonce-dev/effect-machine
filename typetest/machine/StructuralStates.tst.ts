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

const States = Machine.defineStates({
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
})

describe("structural active state types", () => {
  it("separates active, valued, and structural identifiers", () => {
    expect<Machine.Machine.ValuedStateIdentifier<typeof States.states>>().type.toBe<
      | "player.transport.Loading"
      | "player.transport.Ready"
      | "player.transport.Ready.Playing"
      | "player.settings.Audible"
      | "player.settings.Muted"
    >()
    expect<Machine.Machine.StructuralStateIdentifier<typeof States.states>>().type.toBe<
      | "player"
      | "player.transport"
      | "player.transport.Empty"
      | "player.transport.Ready.Paused"
      | "player.settings"
    >()
  })

  it("requires values only for schema-backed snapshot builders", () => {
    States.initial.player.from((player) =>
      player
        .transport.from((transport) => transport.Empty.from())
        .settings.from((settings) => settings.Audible.from({ volume: 1 }))
    )

    expect(States.initial.player.from).type.not.toBeCallableWith({}, () => undefined)
    expect<typeof States.initial.player extends (...args: ReadonlyArray<any>) => any ? true : false>().type.toBe<
      false
    >()

    type PlayerBuilder = Parameters<typeof States.initial.player.from>[0] extends (builder: infer Builder) => unknown
      ? Builder
      : never
    const player = null as unknown as PlayerBuilder
    expect(player.transport.from).type.not.toBeCallableWith((transport: unknown) => transport)

    type TransportBuilder = Parameters<typeof player.transport.from>[0] extends (builder: infer Builder) => unknown
      ? Builder
      : never
    const transport = null as unknown as TransportBuilder
    expect(transport.Empty.from).type.toBeCallableWith()
    expect(transport.Empty.from).type.not.toBeCallableWith({})
    type SettingsBuilder = Parameters<typeof player.settings.from>[0] extends (builder: infer Builder) => unknown
      ? Builder
      : never
    const settings = null as unknown as SettingsBuilder
    expect(settings.Audible.from).type.toBeCallableWith({ volume: 1 })
    expect(settings.Audible.from).type.not.toBeCallableWith()
  })

  it("restricts value access while retaining structural snapshot queries", () => {
    type Snapshot = Machine.Machine.Snapshot<typeof States.states>
    const snapshot = null as unknown as Snapshot

    expect(States.get(snapshot, "player.transport.Loading")).type.toBe<Option.Option<Loading>>()
    expect(States.get).type.not.toBeCallableWith(snapshot, "player")
    expect(States.get).type.not.toBeCallableWith(snapshot, "player.transport.Empty")
    expect(States.getWithParents).type.not.toBeCallableWith(snapshot, "player.transport")

    expect(States.matches).type.toBeCallableWith(snapshot, "player")
    expect(States.matches).type.toBeCallableWith(snapshot, "player.transport.Empty")
    expect(States.getSnapshot).type.toBeCallableWith(snapshot, "player.transport")
    expect(States.getSnapshot(snapshot, "player.transport")).type.toBe<
      Option.Option<Machine.Machine.SnapshotByIdentifier<typeof States.states, "player.transport">>
    >()
  })

  it("types structural handler contexts and targets without fake values", () => {
    Machine.make({
      states: States.states,
      events: [Select, Loaded, Play],
      initial: () =>
        States.initial.player.from((player) =>
          player
            .transport.from((transport) => transport.Empty.from())
            .settings.from((settings) => settings.Audible.from({ volume: 1 }))
        )
    }).handle({
      player: {
        states: {
          transport: {
            states: {
              Empty: {
                entry: ({ state }) => {
                  expect(state).type.toBe<undefined>()
                },
                on: {
                  Select: ({ parent, parents, state, target }) => {
                    expect(state).type.toBe<undefined>()
                    expect(parent).type.toBe<undefined>()
                    expect(parents).type.toBe<{}>()
                    expect(target.local).type.not.toHaveProperty("with")
                    expect(target.local.Empty.from).type.toBeCallableWith()
                    expect(target.local.Empty.from).type.not.toBeCallableWith({})
                    expect(target.local.Loading.from).type.toBeCallableWith({ url: "/song.mp3" })
                    expect(target.local.Loading.from).type.not.toBeCallableWith()
                    return target.local.Loading.from({ url: "/song.mp3" })
                  }
                }
              },
              Loading: {
                on: {
                  Loaded: ({ event, target }) =>
                    target.local.Ready.from(
                      { duration: event.duration },
                      (ready) => ready.Paused.from()
                    )
                }
              },
              Ready: {
                states: {
                  Paused: {
                    on: {
                      Play: ({ parent, parents, state, target }) => {
                        expect(state).type.toBe<undefined>()
                        expect(parent).type.toBe<Ready>()
                        expect(parents).type.toBe<{ readonly "player.transport.Ready": Ready }>()
                        expect(target.local).type.toHaveProperty("with")
                        expect(target.local.Playing.from).type.toBeCallableWith({ position: 0 })
                        return target.local.with.from(
                          { duration: parent.duration },
                          (ready) => ready.Playing.from({ position: 0 })
                        )
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
    expect(Machine.defineStates).type.not.toBeCallableWith({
      invalid: { states: { child: {} } }
    })
    expect(Machine.defineStates).type.not.toBeCallableWith({
      invalid: { type: "parallel" }
    })
    expect(Machine.defineStates).type.not.toBeCallableWith({
      invalid: { schema: undefined }
    })
  })
})
