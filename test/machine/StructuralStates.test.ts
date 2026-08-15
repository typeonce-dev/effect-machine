import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { Machine } from "../../src/index.js"

class Loading extends Schema.TaggedClass<Loading>("StructuralLoading")("Loading", {
  url: Schema.String
}) {}
class Ready extends Schema.TaggedClass<Ready>("StructuralReady")("Ready", {
  duration: Schema.Number
}) {}
class Playing extends Schema.TaggedClass<Playing>("StructuralPlaying")("Playing", {
  position: Schema.Number
}) {}
class Audible extends Schema.TaggedClass<Audible>("StructuralAudible")("Audible", {
  volume: Schema.Number
}) {}
class Muted extends Schema.TaggedClass<Muted>("StructuralMuted")("Muted", {
  volume: Schema.Number
}) {}

class SourceSelected extends Schema.TaggedClass<SourceSelected>("StructuralSourceSelected")("SourceSelected", {
  url: Schema.String
}) {}
class Loaded extends Schema.TaggedClass<Loaded>("StructuralLoaded")("Loaded", {
  duration: Schema.Number
}) {}
class Play extends Schema.TaggedClass<Play>("StructuralPlay")("Play", {}) {}
class Mute extends Schema.TaggedClass<Mute>("StructuralMute")("Mute", {
  volume: Schema.Number
}) {}
class Edit extends Schema.TaggedClass<Edit>("StructuralEdit")("Edit", {
  draft: Schema.String
}) {}
class Leave extends Schema.TaggedClass<Leave>("StructuralLeave")("Leave", {}) {}
class ResumeShallow extends Schema.TaggedClass<ResumeShallow>("StructuralResumeShallow")("ResumeShallow", {}) {}
class ResumeDeep extends Schema.TaggedClass<ResumeDeep>("StructuralResumeDeep")("ResumeDeep", {}) {}
class Editing extends Schema.TaggedClass<Editing>("StructuralEditing")("Editing", {
  draft: Schema.String
}) {}

const States = Machine.defineStates({
  player: {
    type: "parallel",
    annotations: { title: "Player" },
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
        states: {
          Audible,
          Muted
        }
      }
    }
  }
})

const initial = States.initial.player.from((player) =>
  player
    .transport.from((transport) => transport.Empty.from())
    .settings.from((settings) => settings.Audible.from({ volume: 1 }))
)

const makeMachine = () =>
  Machine.make({
    states: States.states,
    events: Machine.events(SourceSelected, Loaded, Play, Mute),
    initial: () => initial
  }).handle({
    player: {
      states: {
        transport: {
          states: {
            Empty: {
              on: {
                SourceSelected: ({ event, state, target }) => {
                  assert.strictEqual(state, undefined)
                  return target.local.Loading.from({ url: event.url })
                }
              }
            },
            Loading: {
              on: {
                Loaded: ({ event, state, target }) => {
                  assert.strictEqual(state._tag, "Loading")
                  return target.local.Ready.from(
                    { duration: event.duration },
                    (ready) => ready.Paused.from()
                  )
                }
              }
            },
            Ready: {
              states: {
                Paused: {
                  on: {
                    Play: ({ containingState, state, target }) => {
                      assert.strictEqual(state, undefined)
                      return target.local.Playing.from({ position: Math.min(0, containingState.duration) })
                    }
                  }
                },
                Playing: {
                  on: {
                    Mute: ({ event, target }) => target.branch.player.settings.Muted.from({ volume: event.volume })
                  }
                }
              }
            }
          }
        }
      }
    }
  })

const HistoryStates = Machine.defineStates({
  flow: {
    initial: "section",
    states: {
      section: {
        initial: "Idle",
        states: {
          Idle: {},
          Editing
        }
      },
      recent: { type: "history" },
      exact: { type: "history", history: "deep" }
    }
  },
  away: {}
})

const historyFallback = () =>
  HistoryStates.initial.flow.from((flow) => flow.section.from((section) => section.Idle.from()))

const historyMachine = Machine.make({
  states: HistoryStates.states,
  events: Machine.events(Edit, Leave, ResumeShallow, ResumeDeep),
  initial: historyFallback
}).handle({
  flow: {
    history: {
      recent: { default: historyFallback },
      exact: { default: historyFallback }
    },
    on: {
      Leave: ({ target }) => target.full.away.from()
    },
    states: {
      section: {
        states: {
          Idle: {
            on: {
              Edit: ({ event, target }) => target.local.Editing.from({ draft: event.draft })
            }
          }
        }
      }
    }
  },
  away: {
    on: {
      ResumeShallow: ({ target }) => target.history.flow.recent(),
      ResumeDeep: ({ target }) => target.history.flow.exact()
    }
  }
})

const FinalStates = Machine.defineStates({
  Done: {
    type: "final",
    output: Schema.String
  }
})

describe("structural active states", () => {
  it.effect("constructs structural atomic, compound, and parallel snapshots without values", () =>
    Effect.gen(function*() {
      const planned = yield* Machine.planInitial(makeMachine())
      const snapshot = planned.state
      assert.deepStrictEqual(snapshot, {
        path: "player",
        value: undefined,
        states: {
          transport: {
            path: "player.transport",
            value: undefined,
            state: {
              path: "player.transport.Empty",
              value: undefined
            }
          },
          settings: {
            path: "player.settings",
            value: undefined,
            state: {
              path: "player.settings.Audible",
              value: new Audible({ volume: 1 })
            }
          }
        }
      })

      assert.isTrue(States.matches(snapshot, "player.transport"))
      assert.isTrue(States.matches(snapshot, "player.transport.Empty"))
      assert.deepStrictEqual(
        States.get(snapshot, "player.settings.Audible"),
        Option.some(new Audible({ volume: 1 }))
      )
      const transport = States.getSnapshot(snapshot, "player.transport")
      assert(Option.isSome(transport))
      assert.strictEqual(transport.value.value, undefined)
    }))

  it.effect("transitions structural to valued, valued to structural, and across parallel regions", () =>
    Effect.gen(function*() {
      const machine = makeMachine()
      const started = yield* Machine.planInitial(machine)

      const loading = yield* Machine.plan(machine, started.state, new SourceSelected({ url: "/song.mp3" }))
      assert.deepStrictEqual(
        States.get(loading.next, "player.transport.Loading"),
        Option.some(new Loading({ url: "/song.mp3" }))
      )

      const paused = yield* Machine.plan(machine, loading.next, new Loaded({ duration: 120 }))
      assert.isTrue(States.matches(paused.next, "player.transport.Ready.Paused"))
      assert.deepStrictEqual(
        States.getWithParents(paused.next, "player.transport.Ready"),
        Option.some({ value: new Ready({ duration: 120 }), parents: {} })
      )

      const playing = yield* Machine.plan(machine, paused.next, new Play({}))
      assert.deepStrictEqual(
        States.getWithParents(playing.next, "player.transport.Ready.Playing"),
        Option.some({
          value: new Playing({ position: 0 }),
          parents: { "player.transport.Ready": new Ready({ duration: 120 }) }
        })
      )

      const muted = yield* Machine.plan(machine, playing.next, new Mute({ volume: 0 }))
      assert.isTrue(States.matches(muted.next, "player.transport.Ready.Playing"))
      assert.deepStrictEqual(
        States.get(muted.next, "player.settings.Muted"),
        Option.some(new Muted({ volume: 0 }))
      )
    }))

  it.effect("encodes active structural paths without inventing values", () =>
    Effect.gen(function*() {
      const machine = makeMachine()
      const started = yield* Machine.planInitial(machine)
      const encoded = yield* Machine.encodeSnapshot(machine, started.state)

      assert.deepStrictEqual(encoded.active, [
        { path: "player" },
        { path: "player.transport" },
        { path: "player.transport.Empty" },
        { path: "player.settings" },
        { path: "player.settings.Audible", value: { _tag: "Audible", volume: 1 } }
      ])

      const decoded = yield* Machine.decodeSnapshot(machine, encoded)
      assert.deepStrictEqual(decoded, started.state)

      const encodedWithStructuralValue = structuredClone(encoded) as any
      encodedWithStructuralValue.active[0].value = { _tag: "Invented" }
      const decodeError = yield* Machine.decodeSnapshot(machine, encodedWithStructuralValue).pipe(Effect.flip)
      assert.instanceOf(decodeError, Machine.MachineSchemaDecodeError)

      const snapshotWithStructuralValue = { ...started.state, value: { _tag: "Invented" } } as any
      const encodeError = yield* Machine.encodeSnapshot(machine, snapshotWithStructuralValue).pipe(Effect.flip)
      assert.instanceOf(encodeError, Machine.MachineSchemaEncodeError)
    }))

  it.effect("restores structural control through shallow and deep history", () =>
    Effect.gen(function*() {
      const started = yield* Machine.planInitial(historyMachine)
      const editing = yield* Machine.plan(historyMachine, started.state, new Edit({ draft: "saved" }))
      const away = yield* Machine.plan(historyMachine, editing.next, new Leave({}))

      const shallow = yield* Machine.plan(historyMachine, away.next, new ResumeShallow({}))
      assert.isTrue(HistoryStates.matches(shallow.next, "flow.section.Idle"))
      assert.isTrue(Option.isNone(HistoryStates.get(shallow.next, "flow.section.Editing")))

      const deep = yield* Machine.plan(historyMachine, away.next, new ResumeDeep({}))
      assert.deepStrictEqual(
        HistoryStates.get(deep.next, "flow.section.Editing"),
        Option.some(new Editing({ draft: "saved" }))
      )
      assert.deepStrictEqual(deep.next.history, away.next.history)
    }))

  it.effect("keeps final output independent from a state value schema", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        states: FinalStates.states,
        events: Machine.events(),
        initial: () => FinalStates.initial.Done.from()
      }).handle({
        Done: {
          output: ({ state }) => {
            assert.strictEqual(state, undefined)
            return "complete"
          }
        }
      })

      const planned = yield* Machine.planInitial(machine)
      assert.isTrue(planned.done)
      assert.strictEqual(planned.output, "complete")
      assert.deepStrictEqual(planned.state, {
        path: "Done",
        value: undefined,
        completed: [{ path: "Done", output: "complete" }]
      })
    }))
})
