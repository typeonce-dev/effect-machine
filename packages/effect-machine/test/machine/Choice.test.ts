import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Machine } from "../../src/index.js"
import { MachineTest } from "../../src/testing/index.js"
class Flow extends Schema.TaggedClass<Flow>("Flow")("Flow", { score: Schema.Number }) {}
class Approved extends Schema.TaggedClass<Approved>("Approved")("Approved", {}) {}
class Rejected extends Schema.TaggedClass<Rejected>("Rejected")("Rejected", {}) {}
class Recheck extends Schema.TaggedClass<Recheck>("Recheck")("Recheck", { score: Schema.Number }) {}
const States = Machine.state({
  states: {
    Flow: {
      schema: Flow,
      states: {
        Routing: { type: "choice" },
        Approved,
        Rejected
      }
    }
  }
})
const machine = Machine.make({
  root: States,
  events: Machine.eventsFromSchemas(Recheck)
}).handle({
  initial: {
    target: "Flow",
    decoded: true,
    data: new Flow({ score: 80 })
  },
  states: {
    Flow: {
      initial: {
        target: "Flow.Routing"
      },
      states: {
        Routing: {
          choice: {
            branches: [{ target: "Flow.Approved" }, { target: "Flow.Rejected" }],
            resolve: ({ containingState, select }) => {
              const score = containingState.score
              return score === 100
                ? select.target("Flow.Approved", { data: new Approved({}), decoded: true })
                : score < 0
                ? select.target("Flow.Rejected", { data: new Rejected({}), decoded: true })
                : score === 0
                ? select.target("Flow.Rejected", { data: new Rejected({}), decoded: true })
                : score >= 70
                ? select.target("Flow.Approved", { data: new Approved({}), decoded: true })
                : select.target("Flow.Rejected", { data: new Rejected({}), decoded: true })
            }
          }
        },
        Approved: {
          on: {
            Recheck: {
              target: "Flow",
              decoded: true,
              data: ({ event }) => (new Flow({ score: event.score }))
            }
          }
        },
        Rejected: {}
      }
    }
  }
})
describe("Machine choice pseudo-states", () => {
  it.effect("settles an initial choice without exposing it in the snapshot", () =>
    Effect.gen(function*() {
      const plan = yield* Machine.planInitial(machine)
      assert.strictEqual(plan.state.state.path, "Flow")
      assert.strictEqual(plan.state.state.state.path, "Flow.Approved")
      assert.deepStrictEqual(Machine.configuration(machine, plan.state).map((node) => node.path), [
        "",
        "Flow",
        "Flow.Approved"
      ])
      assert.strictEqual(plan.microsteps[0]?.transitions[0]?.source, "Flow.Routing")
      assert.strictEqual(plan.microsteps[0]?.transitions[0]?.branchIndex, 0)
      assert.strictEqual(plan.microsteps[0]?.transitions[0]?.branchKey, "target:Flow.Approved")
      assert.strictEqual(Machine.isInitialEvent(plan.microsteps[0]!.event), true)
      const choice = Machine.transitionDefinitions(machine).find(({ source }) => source === "Flow.Routing")
      assert.deepStrictEqual(choice?.branches, [
        {
          type: "branch",
          key: "target:Flow.Approved",
          target: "Flow.Approved",
          selection: { path: "Flow.Approved", kind: "state", scope: "branch" },
          updates: []
        },
        {
          type: "branch",
          key: "target:Flow.Rejected",
          target: "Flow.Rejected",
          selection: { path: "Flow.Rejected", kind: "state", scope: "branch" },
          updates: []
        }
      ])
      assert.deepStrictEqual(Machine.stateNodes(machine).map(({ path, type }) => ({ path, type })), [
        { path: "" as const, type: "compound" },
        { path: "Flow" as const, type: "compound" },
        { path: "Flow.Routing" as const, type: "choice" },
        { path: "Flow.Approved" as const, type: "atomic" },
        { path: "Flow.Rejected" as const, type: "atomic" }
      ])
    }))
  it.effect("decodes initial state constructions before resolving a choice", () =>
    Effect.gen(function*() {
      class Root extends Schema.TaggedClass<Root>("ChoiceInputRoot")("ChoiceInputRoot", {
        enabled: Schema.Boolean
      }) {
      }
      class NestedFlow extends Schema.TaggedClass<NestedFlow>("ChoiceInputFlow")("ChoiceInputFlow", {
        score: Schema.Number
      }) {
      }
      const states = Machine.state({
        fields: {
          input: Schema.toType(Schema.Struct({ enabled: Schema.Boolean, score: Schema.Number }))
        },
        states: {
          Root: {
            schema: Root,
            states: {
              Flow: {
                schema: NestedFlow,
                states: {
                  Routing: { type: "choice" },
                  Approved,
                  Rejected
                }
              }
            }
          }
        }
      })
      let observedContext: {
        readonly enabled: boolean
        readonly score: number
      } | undefined
      const inputChoice = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas(),
        input: Schema.Struct({ enabled: Schema.Boolean, score: Schema.Number })
      }).handle({
        initial: {
          target: "Root",
          data: ({ root: { input } }) => ({ enabled: input.enabled })
        },
        root: ({ input }) => ({ input }),
        states: {
          Root: {
            initial: {
              target: "Root.Flow",
              data: ({ root: { input } }) => ({ score: input.score })
            },
            states: {
              Flow: {
                initial: {
                  target: "Root.Flow.Routing"
                },
                states: {
                  Routing: {
                    choice: {
                      branches: [{ target: "Root.Flow.Approved" }, { target: "Root.Flow.Rejected" }],
                      resolve: ({ ancestors, containingState, select }) => {
                        observedContext = {
                          enabled: ancestors.Root.enabled,
                          score: containingState.score
                        }
                        return ancestors.Root.enabled && containingState.score >= 70
                          ? select.target("Root.Flow.Approved", { data: new Approved({}), decoded: true })
                          : select.target("Root.Flow.Rejected", { data: new Rejected({}), decoded: true })
                      }
                    }
                  },
                  Approved: {},
                  Rejected: {}
                }
              }
            }
          }
        }
      })
      const plan = yield* Machine.planInitial(inputChoice, { enabled: true, score: 80 })
      assert.deepStrictEqual(observedContext, { enabled: true, score: 80 })
      assert.strictEqual(plan.state.state.state.state.path, "Root.Flow.Approved")
      assert.strictEqual(plan.microsteps[0]?.transitions[0]?.branchKey, "target:Root.Flow.Approved")
    }))
  it.effect("targets a choice from an event and preserves that event", () =>
    Effect.gen(function*() {
      const initial = yield* Machine.planInitial(machine)
      const plan = yield* Machine.plan(machine, initial.state, new Recheck({ score: 10 }))
      assert.strictEqual(plan.next.state.state.path, "Flow.Rejected")
      assert.strictEqual(plan.microsteps[0]?.event._tag, "Recheck")
      assert.deepStrictEqual(plan.microsteps[0]?.transitions.map(({ source, trigger }) => ({ source, trigger })), [
        { source: "Flow.Approved", trigger: { type: "event", event: "Recheck" } },
        { source: "Flow.Routing", trigger: { type: "choice" } }
      ])
    }))
  it.effect("stabilizes chained choices and attributes every resolver microstep", () =>
    Effect.gen(function*() {
      const states = Machine.state({
        states: {
          Flow: {
            schema: Flow,
            states: {
              First: { type: "choice" },
              Second: { type: "choice" },
              Approved
            }
          }
        }
      })
      const chained = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: "Flow",
          decoded: true,
          data: new Flow({ score: 80 })
        },
        states: {
          Flow: {
            initial: {
              target: "Flow.First"
            },
            states: {
              First: {
                choice: { branches: [{ target: "Flow.Second" }], resolve: ({ select }) => select.target("Flow.Second") }
              },
              Second: {
                choice: { target: "Flow.Approved", decoded: true, data: () => (new Approved({})) }
              },
              Approved: {}
            }
          }
        }
      })
      const plan = yield* Machine.planInitial(chained)
      assert.strictEqual(plan.state.state.state.path, "Flow.Approved")
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
      const states = Machine.state({
        states: {
          Flow: {
            schema: Flow,
            states: {
              First: { type: "choice" },
              Second: { type: "choice" },
              Approved
            }
          }
        }
      })
      const looping = Machine.make({
        id: "ChoiceLoopMachine",
        root: states,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: "Flow",
          decoded: true,
          data: new Flow({ score: 80 })
        },
        states: {
          Flow: {
            initial: {
              target: "Flow.First"
            },
            states: {
              First: {
                choice: { branches: [{ target: "Flow.Second" }], resolve: ({ select }) => select.target("Flow.Second") }
              },
              Second: {
                choice: { branches: [{ target: "Flow.First" }], resolve: ({ select }) => select.target("Flow.First") }
              },
              Approved: {}
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
      const states = Machine.state({
        states: {
          Flow: {
            schema: Flow,
            states: {
              Approved,
              Routing: { type: "choice" },
              Rejected
            }
          }
        }
      })
      const alwaysMachine = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: "Flow",
          decoded: true,
          data: new Flow({ score: 10 })
        },
        states: {
          Flow: {
            initial: {
              target: "Flow.Approved",
              decoded: true,
              data: new Approved({})
            },
            states: {
              Approved: {
                always: {
                  branches: [{ target: "Flow.Routing" }],
                  resolve: ({ select }) => select.target("Flow.Routing")
                }
              },
              Routing: {
                choice: { target: "Flow.Rejected", decoded: true, data: () => (new Rejected({})) }
              },
              Rejected: {}
            }
          }
        }
      })
      const plan = yield* Machine.planInitial(alwaysMachine)
      assert.strictEqual(plan.state.state.state.path, "Flow.Rejected")
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
      class Done extends Schema.TaggedClass<Done>("Done")("Done", {}) {
      }
      const states = Machine.state({
        states: {
          Flow: {
            schema: Flow,
            states: {
              Done: { schema: Done, type: "final" },
              Routing: { type: "choice" },
              Rejected
            }
          }
        }
      })
      const completion = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: "Flow",
          decoded: true,
          data: new Flow({ score: 0 })
        },
        states: {
          Flow: {
            initial: {
              target: "Flow.Done",
              decoded: true,
              data: new Done({})
            },
            onDone: {
              branches: [{ target: "Flow" }],
              resolve: ({ state, select }) =>
                select.target("Flow", { data: state, decoded: true, states: { Routing: {} } })
            },
            states: {
              Done: {},
              Routing: {
                choice: { target: "Flow.Rejected", decoded: true, data: () => (new Rejected({})) }
              },
              Rejected: {}
            }
          }
        }
      })
      const plan = yield* Machine.planInitial(completion)
      assert.strictEqual(plan.state.state.state.path, "Flow.Rejected")
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
      class Board extends Schema.TaggedClass<Board>("Board")("Board", {}) {
      }
      class Left extends Schema.TaggedClass<Left>("Left")("Left", {}) {
      }
      class Ready extends Schema.TaggedClass<Ready>("Ready")("Ready", {}) {
      }
      class Right extends Schema.TaggedClass<Right>("Right")("Right", {}) {
      }
      class RightReady extends Schema.TaggedClass<RightReady>("RightReady")("RightReady", {}) {
      }
      const states = Machine.state({
        states: {
          Board: {
            schema: Board,
            type: "parallel",
            states: {
              Left: {
                schema: Left,
                states: {
                  Routing: { type: "choice" },
                  Ready
                }
              },
              Right: {
                schema: Right,
                states: {
                  Routing: { type: "choice" },
                  Ready: RightReady
                }
              }
            }
          }
        }
      })
      const parallel = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: "Board",
          decoded: true,
          data: new Board({})
        },
        states: {
          Board: {
            initial: { Left: { decoded: true, data: new Left({}) }, Right: { decoded: true, data: new Right({}) } },
            states: {
              Left: {
                initial: {
                  target: "Board.Left.Routing"
                },
                states: {
                  Routing: {
                    choice: { target: "Board.Left.Ready", decoded: true, data: () => (new Ready({})) }
                  },
                  Ready: {}
                }
              },
              Right: {
                initial: {
                  target: "Board.Right.Routing"
                },
                states: {
                  Routing: {
                    choice: { target: "Board.Right.Ready", decoded: true, data: () => (new RightReady({})) }
                  },
                  Ready: {}
                }
              }
            }
          }
        }
      })
      const plan = yield* Machine.planInitial(parallel)
      assert.deepStrictEqual(Machine.configuration(parallel, plan.state).map(({ path }) => path), [
        "",
        "Board",
        "Board.Left",
        "Board.Left.Ready",
        "Board.Right",
        "Board.Right.Ready"
      ])
    }))
  it.effect("resolves through a recorded history target", () =>
    Effect.gen(function*() {
      class Active extends Schema.TaggedClass<Active>("Active")("Active", {}) {
      }
      class Outside extends Schema.TaggedClass<Outside>("Outside")("Outside", {}) {
      }
      class Leave extends Schema.TaggedClass<Leave>("Leave")("Leave", {}) {
      }
      class Resume extends Schema.TaggedClass<Resume>("Resume")("Resume", {}) {
      }
      const states = Machine.state({
        states: {
          Flow: {
            schema: Flow,
            states: {
              Active,
              Routing: { type: "choice" },
              Recent: { type: "history" }
            }
          },
          Outside
        }
      })
      const history = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas(Leave, Resume)
      }).handle({
        initial: {
          target: "Flow",
          decoded: true,
          data: new Flow({ score: 1 })
        },
        states: {
          Flow: {
            initial: {
              target: "Flow.Active",
              decoded: true,
              data: new Active({})
            },
            history: {
              Recent: {
                default: ({ target }) =>
                  target({
                    states: {
                      Flow: {
                        data: new Flow({ score: 0 }),
                        decoded: true,
                        states: { Active: { data: new Active({}), decoded: true } }
                      }
                    }
                  })
              }
            },
            states: {
              Active: {
                on: {
                  Leave: { target: "Outside", decoded: true, data: () => (new Outside({})) }
                }
              },
              Routing: {
                choice: {
                  branches: [{ history: "Flow.Recent" }],
                  resolve: ({ select }) => select.history("Flow.Recent")
                }
              }
            }
          },
          Outside: {
            on: {
              Resume: {
                branches: [{ target: "Flow" }],
                resolve: ({ select }) =>
                  select.target("Flow", { data: new Flow({ score: 2 }), decoded: true, states: { Routing: {} } })
              }
            }
          }
        }
      })
      const initial = yield* Machine.planInitial(history)
      const outside = yield* Machine.plan(history, initial.state, new Leave({}))
      const resumed = yield* Machine.plan(history, outside.next, new Resume({}))
      assert.strictEqual(resumed.next.state.path, "Flow")
      if (resumed.next.state.path === "Flow") {
        assert.strictEqual(resumed.next.state.state.path, "Flow.Active")
      }
      assert.deepStrictEqual(resumed.microsteps[0]?.transitions.map(({ trigger }) => trigger.type), ["event", "choice"])
      const trace = yield* MachineTest.run(history, { events: [new Leave({}), new Resume({})] })
      yield* MachineTest.verify(history, trace, { laws: ["definitions"] })
    }))
  it.effect("uses a history default when an initial choice targets history", () =>
    Effect.gen(function*() {
      class Active extends Schema.TaggedClass<Active>("InitialHistoryActive")("InitialHistoryActive", {}) {
      }
      const states = Machine.state({
        states: {
          Flow: {
            schema: Flow,
            states: {
              Active,
              Routing: { type: "choice" },
              Recent: { type: "history" }
            }
          }
        }
      })
      const initialHistory = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: "Flow",
          decoded: true,
          data: new Flow({ score: 1 })
        },
        states: {
          Flow: {
            initial: {
              target: "Flow.Routing"
            },
            history: {
              Recent: {
                default: () => ({
                  path: "" as const,
                  value: undefined,
                  state: {
                    path: "Flow" as const,
                    value: new Flow({ score: 0 }),
                    state: { path: "Flow.Active" as const, value: new Active({}) }
                  }
                })
              }
            },
            states: {
              Active: {},
              Routing: {
                choice: {
                  branches: [{ history: "Flow.Recent" }],
                  resolve: ({ select }) => select.history("Flow.Recent")
                }
              }
            }
          }
        }
      })
      const plan = yield* Machine.planInitial(initialHistory)
      assert.strictEqual(plan.state.state.state.path, "Flow.Active")
      const trace = yield* MachineTest.run(initialHistory, { events: [] })
      yield* MachineTest.verify(initialHistory, trace, { laws: ["definitions"] })
    }))
  it.effect("resolves a nested choice inside a first-use history fallback", () =>
    Effect.gen(function*() {
      class Active extends Schema.TaggedClass<Active>("FallbackChoiceActive")("FallbackChoiceActive", {}) {
      }
      class Outside extends Schema.TaggedClass<Outside>("FallbackChoiceOutside")("FallbackChoiceOutside", {}) {
      }
      class Resume extends Schema.TaggedClass<Resume>("FallbackChoiceResume")("FallbackChoiceResume", {}) {
      }
      const states = Machine.state({
        states: {
          Flow: {
            schema: Flow,
            states: {
              Active,
              Routing: { type: "choice" },
              Recent: { type: "history" }
            }
          },
          Outside
        }
      })
      const historyChoice = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas(Resume)
      }).handle({
        initial: {
          target: "Outside",
          decoded: true,
          data: new Outside({})
        },
        states: {
          Flow: {
            initial: {
              target: "Flow.Active"
            },
            history: {
              Recent: {
                default: ({ target }) =>
                  target({ states: { Flow: { data: new Flow({ score: 1 }), decoded: true, states: { Routing: {} } } } })
              }
            },
            states: {
              Active: {},
              Routing: {
                choice: { target: "Flow.Active", decoded: true, data: () => (new Active({})) }
              }
            }
          },
          Outside: {
            on: {
              FallbackChoiceResume: {
                branches: [{ history: "Flow.Recent" }],
                resolve: ({ select }) => select.history("Flow.Recent")
              }
            }
          }
        }
      })
      const initial = yield* Machine.planInitial(historyChoice)
      const resumed = yield* Machine.plan(historyChoice, initial.state, new Resume({}))
      assert.strictEqual(resumed.next.state.path, "Flow")
      if (resumed.next.state.path === "Flow") {
        assert.strictEqual(resumed.next.state.state.path, "Flow.Active")
      }
      assert.deepStrictEqual(
        resumed.microsteps[0]?.transitions.map(({ source, trigger }) => ({ source, trigger: trigger.type })),
        [
          { source: "Outside", trigger: "event" },
          { source: "Flow.Routing", trigger: "choice" }
        ]
      )
      const historyDefinition = Machine.transitionDefinitions(historyChoice).find(({ source, trigger }) =>
        source === "Outside" && trigger.type === "event" && trigger.event === "FallbackChoiceResume"
      )
      assert.deepStrictEqual(historyDefinition?.branches[0]?.selection, {
        path: "Flow.Recent",
        kind: "history",
        scope: "full"
      })
    }))
  it("inspects declared choice edges without executing the resolver", () => {
    const definitions = Machine.transitionDefinitions(machine)
    assert.deepStrictEqual(definitions.filter(({ trigger }) => trigger.type === "choice"), [
      {
        source: "Flow.Routing",
        trigger: { type: "choice" },
        reenter: false,
        acceptance: "required",
        branches: [{
          type: "branch",
          key: "target:Flow.Approved",
          target: "Flow.Approved",
          selection: { path: "Flow.Approved", kind: "state", scope: "branch" },
          updates: []
        }, {
          type: "branch",
          key: "target:Flow.Rejected",
          target: "Flow.Rejected",
          selection: { path: "Flow.Rejected", kind: "state", scope: "branch" },
          updates: []
        }]
      }
    ])
    const recheck = definitions.find(({ source, trigger }) =>
      source === "Flow.Approved" && trigger.type === "event" && trigger.event === "Recheck"
    )
    assert.deepStrictEqual(recheck?.branches[0]?.selection, {
      path: "Flow",
      kind: "state",
      scope: "branch"
    })
  })
  it.effect("attributes choice microsteps in MachineTest traces and coverage", () =>
    Effect.gen(function*() {
      const trace = yield* MachineTest.run(machine, { events: [new Recheck({ score: 10 })] })
      const coverage = MachineTest.coverage(machine, trace)
      assert.strictEqual(coverage.microsteps.choiceTriggered, 2)
      const choiceBranches = coverage.transitions.branches.hits.filter(({ trigger }) => trigger.type === "choice")
      assert.deepStrictEqual(choiceBranches.map(({ branchIndex }) => branchIndex), [0, 1])
      assert.deepStrictEqual(
        coverage.transitions.branches.misses
          .filter(({ trigger }) => trigger.type === "choice")
          .map(({ branchIndex }) => branchIndex),
        []
      )
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
