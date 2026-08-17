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

const makeMachine = () =>
  Machine.make({
    states: States.states,
    events: Machine.events(SourceSelected, Loaded, Play, Mute),
    initial: {
      target: (to) => to.player.initial(),
      resolve: ({ target }) =>
        target.from((player) =>
          player
            .transport.from((transport) => transport.Empty.from())
            .settings.from((settings) => settings.Audible.from({ volume: 1 }))
        )
    }
  }).handle({
    player: {
      states: {
        transport: {
          states: {
            Empty: {
              on: {
                SourceSelected: Machine.transition({
                  target: (to) => to.local.Loading(),
                  resolve: ({ event, state, target }) => {
                    assert.strictEqual(state, undefined)
                    return target.from({ url: event.url })
                  }
                })
              }
            },
            Loading: {
              on: {
                Loaded: Machine.transition({
                  target: (to) => to.local.Ready(),
                  resolve: ({ event, state, target }) => {
                    assert.strictEqual(state._tag, "Loading")
                    return target.from(
                      { duration: event.duration },
                      (ready) => ready.Paused.from()
                    )
                  }
                })
              }
            },
            Ready: {
              states: {
                Paused: {
                  on: {
                    Play: Machine.transition({
                      target: (to) => to.local.Playing(),
                      resolve: ({ containingState, state, target }) => {
                        assert.strictEqual(state, undefined)
                        return target.from({ position: Math.min(0, containingState.duration) })
                      }
                    })
                  }
                },
                Playing: {
                  on: {
                    Mute: Machine.transition({
                      target: (to) => to.branch.player.settings.Muted(),
                      resolve: ({ event, target }) => target.from({ volume: event.volume })
                    })
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

const historyFallback = () => ({
  path: "flow" as const,
  value: undefined,
  state: {
    path: "flow.section" as const,
    value: undefined,
    state: { path: "flow.section.Idle" as const, value: undefined }
  }
})

const historyMachine = Machine.make({
  states: HistoryStates.states,
  events: Machine.events(Edit, Leave, ResumeShallow, ResumeDeep),
  initial: {
    target: (to) => to.flow.initial(),
    resolve: ({ target }) => target.from((flow) => flow.section.from((section) => section.Idle.from()))
  }
}).handle({
  flow: {
    history: {
      recent: { default: historyFallback },
      exact: { default: historyFallback }
    },
    on: {
      Leave: Machine.transition({
        target: (to) => to.full.away(),
        resolve: ({ target }) => target.from()
      })
    },
    states: {
      section: {
        states: {
          Idle: {
            on: {
              Edit: Machine.transition({
                target: (to) => to.local.Editing(),
                resolve: ({ event, target }) => target.from({ draft: event.draft })
              })
            }
          }
        }
      }
    }
  },
  away: {
    on: {
      ResumeShallow: Machine.transition({
        target: (to) => to.history.flow.recent(),
        resolve: ({ target }) => target()
      }),
      ResumeDeep: Machine.transition({
        target: (to) => to.history.flow.exact(),
        resolve: ({ target }) => target()
      })
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
        path: "player" as const,
        value: undefined,
        states: {
          transport: {
            path: "player.transport" as const,
            value: undefined,
            state: {
              path: "player.transport.Empty" as const,
              value: undefined
            }
          },
          settings: {
            path: "player.settings" as const,
            value: undefined,
            state: {
              path: "player.settings.Audible" as const,
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
        { path: "player" as const },
        { path: "player.transport" as const },
        { path: "player.transport.Empty" as const },
        { path: "player.settings" as const },
        { path: "player.settings.Audible" as const, value: { _tag: "Audible", volume: 1 } }
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
        initial: {
          target: (to) => to.Done(),
          resolve: ({ target }) => target.from()
        }
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
        path: "Done" as const,
        value: undefined,
        completed: [{ path: "Done" as const, output: "complete" }]
      })
    }))
})
