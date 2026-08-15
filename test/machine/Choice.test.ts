import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Machine } from "../../src/index.js"
import { MachineTest } from "../../src/testing/index.js"

class Flow extends Schema.TaggedClass<Flow>("Flow")("Flow", { score: Schema.Number }) {}
class Approved extends Schema.TaggedClass<Approved>("Approved")("Approved", {}) {}
class Rejected extends Schema.TaggedClass<Rejected>("Rejected")("Rejected", {}) {}
class Recheck extends Schema.TaggedClass<Recheck>("Recheck")("Recheck", { score: Schema.Number }) {}

const States = Machine.defineStates({
  Flow: {
    schema: Flow,
    initial: "Routing",
    states: {
      Routing: { type: "choice" },
      Approved,
      Rejected
    }
  }
})

const machine = Machine.make({
  states: States.states,
  events: Machine.events(Recheck),
  initial: () => States.initial.Flow(new Flow({ score: 80 }), (flow) => flow.Routing())
}).handle({
  Flow: {
    states: {
      Routing: {
        choice: {
          targets: ["Flow.Approved", "Flow.Rejected"],
          transition: ({ containingState, target }) => {
            return containingState.score >= 70
              ? target.local.Approved(new Approved({}))
              : target.local.Rejected(new Rejected({}))
          }
        }
      },
      Approved: {
        on: {
          Recheck: ({ event, target }) => target.local.with(new Flow({ score: event.score }), (flow) => flow.Routing())
        }
      }
    }
  }
})

describe("Machine choice pseudo-states", () => {
  it.effect("settles an initial choice without exposing it in the snapshot", () =>
    Effect.gen(function*() {
      const plan = yield* Machine.planInitial(machine)
      assert.strictEqual(plan.state.path, "Flow")
      assert.strictEqual(plan.state.state.path, "Flow.Approved")
      assert.deepStrictEqual(Machine.configuration(machine, plan.state).map((node) => node.path), [
        "Flow",
        "Flow.Approved"
      ])
      assert.strictEqual(plan.microsteps[0]?.transitions[0]?.source, "Flow.Routing")
      assert.strictEqual(Machine.isInitialEvent(plan.microsteps[0]!.event), true)
      assert.deepStrictEqual(Machine.stateNodes(machine).map(({ path, type }) => ({ path, type })), [
        { path: "Flow", type: "compound" },
        { path: "Flow.Routing", type: "choice" },
        { path: "Flow.Approved", type: "atomic" },
        { path: "Flow.Rejected", type: "atomic" }
      ])
    }))

  it.effect("targets a choice from an event and preserves that event", () =>
    Effect.gen(function*() {
      const initial = yield* Machine.planInitial(machine)
      const plan = yield* Machine.plan(machine, initial.state, new Recheck({ score: 10 }))
      assert.strictEqual(plan.next.state.path, "Flow.Rejected")
      assert.strictEqual(plan.microsteps[0]?.event._tag, "Recheck")
      assert.deepStrictEqual(plan.microsteps[0]?.transitions.map(({ source, trigger }) => ({ source, trigger })), [
        { source: "Flow.Approved", trigger: { type: "event", event: "Recheck" } },
        { source: "Flow.Routing", trigger: { type: "choice" } }
      ])
    }))

  it.effect("stabilizes chained choices and attributes every resolver microstep", () =>
    Effect.gen(function*() {
      const states = Machine.defineStates({
        Flow: {
          schema: Flow,
          initial: "First",
          states: {
            First: { type: "choice" },
            Second: { type: "choice" },
            Approved
          }
        }
      })
      const chained = Machine.make({
        states: states.states,
        events: Machine.events(),
        initial: () => states.initial.Flow(new Flow({ score: 80 }), (flow) => flow.First())
      }).handle({
        Flow: {
          states: {
            First: {
              choice: {
                targets: ["Flow.Second"],
                transition: ({ target }) => target.local.Second()
              }
            },
            Second: {
              choice: {
                targets: ["Flow.Approved"],
                transition: ({ target }) => target.local.Approved(new Approved({}))
              }
            }
          }
        }
      })

      const plan = yield* Machine.planInitial(chained)
      assert.strictEqual(plan.state.state.path, "Flow.Approved")
      assert.deepStrictEqual(
        plan.microsteps[0]?.transitions.map(({ source, resolvedTarget }) => ({
          source,
          resolvedTarget
        })),
        [
          { source: "Flow.First", resolvedTarget: "Flow.Second" },
          { source: "Flow.Second", resolvedTarget: "Flow.Approved" }
        ]
      )
      assert.notInclude(JSON.stringify(plan.state), "Flow.First")
      assert.notInclude(JSON.stringify(plan.state), "Flow.Second")
    }))

  it.effect("uses the existing infinite-transition protection for choice loops", () =>
    Effect.gen(function*() {
      const states = Machine.defineStates({
        Flow: {
          schema: Flow,
          initial: "First",
          states: {
            First: { type: "choice" },
            Second: { type: "choice" },
            Approved
          }
        }
      })
      const looping = Machine.make({
        id: "ChoiceLoopMachine",
        states: states.states,
        events: Machine.events(),
        initial: () => states.initial.Flow(new Flow({ score: 80 }), (flow) => flow.First())
      }).handle({
        Flow: {
          states: {
            First: {
              choice: { targets: ["Flow.Second"], transition: ({ target }) => target.local.Second() }
            },
            Second: {
              choice: { targets: ["Flow.First"], transition: ({ target }) => target.local.First() }
            }
          }
        }
      })

      const error = yield* Effect.flip(Machine.planInitial(looping))
      assert.instanceOf(error, Machine.InfiniteTransitionError)
      assert.strictEqual(error.machineId, "ChoiceLoopMachine")
      assert.strictEqual(error.maxIterations, 1000)
    }))

  it.effect("enters a choice from an always transition", () =>
    Effect.gen(function*() {
      const states = Machine.defineStates({
        Flow: {
          schema: Flow,
          initial: "Approved",
          states: {
            Approved,
            Routing: { type: "choice" },
            Rejected
          }
        }
      })
      const alwaysMachine = Machine.make({
        states: states.states,
        events: Machine.events(),
        initial: () =>
          states.initial.Flow(
            new Flow({ score: 10 }),
            (flow) => flow.Approved(new Approved({}))
          )
      }).handle({
        Flow: {
          states: {
            Approved: {
              always: ({ target }) => target.local.Routing()
            },
            Routing: {
              choice: {
                targets: ["Flow.Rejected"],
                transition: ({ target }) => target.local.Rejected(new Rejected({}))
              }
            }
          }
        }
      })

      const plan = yield* Machine.planInitial(alwaysMachine)
      assert.strictEqual(plan.state.state.path, "Flow.Rejected")
      assert.deepStrictEqual(
        plan.microsteps.flatMap(({ transitions }) => transitions.map(({ trigger }) => trigger.type)),
        [
          "always",
          "choice"
        ]
      )
    }))

  it.effect("round-trips only the settled concrete snapshot", () =>
    Effect.gen(function*() {
      const initial = yield* Machine.planInitial(machine)
      const encoded = yield* Machine.encodeSnapshot(machine, initial.state)
      assert.notInclude(JSON.stringify(encoded), "Routing")
      const decoded = yield* Machine.decodeSnapshot(machine, encoded)
      assert.deepStrictEqual(decoded, initial.state)
    }))

  it.effect("enters a choice from a completion transition", () =>
    Effect.gen(function*() {
      class Done extends Schema.TaggedClass<Done>("Done")("Done", {}) {}
      const states = Machine.defineStates({
        Flow: {
          schema: Flow,
          initial: "Done",
          states: {
            Done: { schema: Done, type: "final" },
            Routing: { type: "choice" },
            Rejected
          }
        }
      })
      const completion = Machine.make({
        states: states.states,
        events: Machine.events(),
        initial: () => states.initial.Flow(new Flow({ score: 0 }), (flow) => flow.Done(new Done({})))
      }).handle({
        Flow: {
          onDone: ({ state, target }) => target.full.Flow(state, (flow) => flow.Routing()),
          states: {
            Routing: {
              choice: {
                targets: ["Flow.Rejected"],
                transition: ({ target }) => target.local.Rejected(new Rejected({}))
              }
            }
          }
        }
      })

      const plan = yield* Machine.planInitial(completion)
      assert.strictEqual(plan.state.state.path, "Flow.Rejected")
      assert.deepStrictEqual(
        plan.microsteps.flatMap(({ transitions }) => transitions.map(({ trigger }) => trigger.type)),
        [
          "done",
          "choice"
        ]
      )
    }))

  it.effect("settles a choice in one parallel region without disturbing its sibling", () =>
    Effect.gen(function*() {
      class Board extends Schema.TaggedClass<Board>("Board")("Board", {}) {}
      class Left extends Schema.TaggedClass<Left>("Left")("Left", {}) {}
      class Ready extends Schema.TaggedClass<Ready>("Ready")("Ready", {}) {}
      class Right extends Schema.TaggedClass<Right>("Right")("Right", {}) {}
      class RightReady extends Schema.TaggedClass<RightReady>("RightReady")("RightReady", {}) {}
      const states = Machine.defineStates({
        Board: {
          schema: Board,
          type: "parallel",
          states: {
            Left: {
              schema: Left,
              initial: "Routing",
              states: {
                Routing: { type: "choice" },
                Ready
              }
            },
            Right: {
              schema: Right,
              initial: "Routing",
              states: {
                Routing: { type: "choice" },
                Ready: RightReady
              }
            }
          }
        }
      })
      const parallel = Machine.make({
        states: states.states,
        events: Machine.events(),
        initial: () =>
          states.initial.Board(
            new Board({}),
            (board) =>
              board
                .Left(new Left({}), (left) => left.Routing())
                .Right(new Right({}), (right) => right.Routing())
          )
      }).handle({
        Board: {
          states: {
            Left: {
              states: {
                Routing: {
                  choice: {
                    targets: ["Board.Left.Ready"],
                    transition: ({ target }) => target.local.Ready(new Ready({}))
                  }
                }
              }
            },
            Right: {
              states: {
                Routing: {
                  choice: {
                    targets: ["Board.Right.Ready"],
                    transition: ({ target }) => target.local.Ready(new RightReady({}))
                  }
                }
              }
            }
          }
        }
      })

      const plan = yield* Machine.planInitial(parallel)
      assert.deepStrictEqual(Machine.configuration(parallel, plan.state).map(({ path }) => path), [
        "Board",
        "Board.Left",
        "Board.Left.Ready",
        "Board.Right",
        "Board.Right.Ready"
      ])
    }))

  it.effect("resolves through a recorded history target", () =>
    Effect.gen(function*() {
      class Active extends Schema.TaggedClass<Active>("Active")("Active", {}) {}
      class Outside extends Schema.TaggedClass<Outside>("Outside")("Outside", {}) {}
      class Leave extends Schema.TaggedClass<Leave>("Leave")("Leave", {}) {}
      class Resume extends Schema.TaggedClass<Resume>("Resume")("Resume", {}) {}
      const states = Machine.defineStates({
        Flow: {
          schema: Flow,
          initial: "Active",
          states: {
            Active,
            Routing: { type: "choice" },
            Recent: { type: "history" }
          }
        },
        Outside
      })
      const history = Machine.make({
        states: states.states,
        events: Machine.events(Leave, Resume),
        initial: () => states.initial.Flow(new Flow({ score: 1 }), (flow) => flow.Active(new Active({})))
      }).handle({
        Flow: {
          history: {
            Recent: {
              default: () => states.initial.Flow(new Flow({ score: 0 }), (flow) => flow.Active(new Active({})))
            }
          },
          states: {
            Active: {
              on: {
                Leave: ({ target }) => target.full.Outside(new Outside({}))
              }
            },
            Routing: {
              choice: {
                targets: ["Flow.Recent"],
                transition: ({ target }) => target.history.Flow.Recent()
              }
            }
          }
        },
        Outside: {
          on: {
            Resume: ({ target }) => target.full.Flow(new Flow({ score: 2 }), (flow) => flow.Routing())
          }
        }
      })

      const initial = yield* Machine.planInitial(history)
      const outside = yield* Machine.plan(history, initial.state, new Leave({}))
      const resumed = yield* Machine.plan(history, outside.next, new Resume({}))
      assert.strictEqual(resumed.next.path, "Flow")
      if (resumed.next.path === "Flow") assert.strictEqual(resumed.next.state.path, "Flow.Active")
      assert.deepStrictEqual(resumed.microsteps[0]?.transitions.map(({ trigger }) => trigger.type), ["event", "choice"])
    }))

  it.effect("uses a history default when an initial choice targets history", () =>
    Effect.gen(function*() {
      class Active extends Schema.TaggedClass<Active>("InitialHistoryActive")("InitialHistoryActive", {}) {}
      const states = Machine.defineStates({
        Flow: {
          schema: Flow,
          initial: "Routing",
          states: {
            Active,
            Routing: { type: "choice" },
            Recent: { type: "history" }
          }
        }
      })
      const initialHistory = Machine.make({
        states: states.states,
        events: Machine.events(),
        initial: () => states.initial.Flow(new Flow({ score: 1 }), (flow) => flow.Routing())
      }).handle({
        Flow: {
          history: {
            Recent: {
              default: () => ({
                path: "Flow",
                value: new Flow({ score: 0 }),
                state: { path: "Flow.Active", value: new Active({}) }
              })
            }
          },
          states: {
            Routing: {
              choice: {
                targets: ["Flow.Recent"],
                transition: ({ target }) => target.history.Flow.Recent()
              }
            }
          }
        }
      })

      const plan = yield* Machine.planInitial(initialHistory)
      assert.strictEqual(plan.state.state.path, "Flow.Active")
    }))

  it.effect("resolves a nested choice inside a first-use history fallback", () =>
    Effect.gen(function*() {
      class Active extends Schema.TaggedClass<Active>("FallbackChoiceActive")("FallbackChoiceActive", {}) {}
      class Outside extends Schema.TaggedClass<Outside>("FallbackChoiceOutside")("FallbackChoiceOutside", {}) {}
      class Resume extends Schema.TaggedClass<Resume>("FallbackChoiceResume")("FallbackChoiceResume", {}) {}
      const states = Machine.defineStates({
        Flow: {
          schema: Flow,
          initial: "Active",
          states: {
            Active,
            Routing: { type: "choice" },
            Recent: { type: "history" }
          }
        },
        Outside
      })
      const historyChoice = Machine.make({
        states: states.states,
        events: Machine.events(Resume),
        initial: () => states.initial.Outside(new Outside({}))
      }).handle({
        Flow: {
          history: {
            Recent: {
              default: ({ target }) => target.Flow(new Flow({ score: 1 }), (flow) => flow.Routing())
            }
          },
          states: {
            Routing: {
              choice: {
                targets: ["Flow.Active"],
                transition: ({ target }) => target.local.Active(new Active({}))
              }
            }
          }
        },
        Outside: {
          on: { FallbackChoiceResume: ({ target }) => target.history.Flow.Recent() }
        }
      })

      const initial = yield* Machine.planInitial(historyChoice)
      const resumed = yield* Machine.plan(historyChoice, initial.state, new Resume({}))
      assert.strictEqual(resumed.next.path, "Flow")
      if (resumed.next.path === "Flow") assert.strictEqual(resumed.next.state.path, "Flow.Active")
      assert.deepStrictEqual(
        resumed.microsteps[0]?.transitions.map(({ source, trigger }) => ({ source, trigger: trigger.type })),
        [
          { source: "Outside", trigger: "event" },
          { source: "Flow.Routing", trigger: "choice" }
        ]
      )
    }))

  it("inspects declared choice edges without executing the resolver", () => {
    assert.deepStrictEqual(Machine.transitionDefinitions(machine).filter(({ trigger }) => trigger.type === "choice"), [
      {
        source: "Flow.Routing",
        trigger: { type: "choice" },
        reenter: false,
        targets: { type: "declared", paths: ["Flow.Approved", "Flow.Rejected"] }
      }
    ])
  })

  it.effect("attributes choice microsteps in MachineTest traces and coverage", () =>
    Effect.gen(function*() {
      const trace = yield* MachineTest.run(machine, { events: [new Recheck({ score: 10 })] })
      const coverage = MachineTest.coverage(machine, trace)
      assert.strictEqual(coverage.microsteps.choiceTriggered, 2)
      assert.deepStrictEqual(
        [trace.initial.plan, ...trace.steps.map(({ plan }) => plan)]
          .flatMap(({ microsteps }) => microsteps)
          .flatMap(({ transitions }) => transitions)
          .filter(({ trigger }) => trigger.type === "choice")
          .map(({ source }) => source),
        ["Flow.Routing", "Flow.Routing"]
      )
    }))
})
