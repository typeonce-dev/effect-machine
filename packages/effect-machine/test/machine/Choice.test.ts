import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Machine } from "../../src/index.js"
import { MachineTest } from "../../src/testing/index.js"

class Flow extends Schema.TaggedClass<Flow>("Flow")("Flow", { score: Schema.Number }) {}
class Approved extends Schema.TaggedClass<Approved>("Approved")("Approved", {}) {}
class Rejected extends Schema.TaggedClass<Rejected>("Rejected")("Rejected", {}) {}
class Recheck extends Schema.TaggedClass<Recheck>("Recheck")("Recheck", { score: Schema.Number }) {}

const States = Machine.state({
  initial: "Flow",
  states: {
    Flow: {
      schema: Flow,
      initial: "Routing",
      states: {
        Routing: { type: "choice" },
        Approved,
        Rejected
      }
    }
  }
})

let branchDeclarationReads = 0

const targets1 = Machine.targets(States)
const machine = Machine.make({
  branches: {
    routing: {
      perfect: {
        get title() {
          branchDeclarationReads++
          return "Score is perfect"
        },
        target: targets1.root.Flow.Approved
      },
      negative: { title: "Score is negative", target: targets1.root.Flow.Rejected },
      zero: { title: "Score is zero", target: targets1.root.Flow.Rejected },
      passing: { title: "Score is at least 70", target: targets1.root.Flow.Approved },
      failing: { target: targets1.root.Flow.Rejected }
    },
    transition1: { destination: { initial: targets1.root.Flow } }
  },

  root: States,
  events: Machine.eventsFromSchemas(Recheck),
  initialConfiguration: (root) =>
    root.resolve(({ target }) =>
      target.from((to) => to.Flow.decoded(new Flow({ score: 80 }), (flow) => flow.Routing()))
    )
}).handle({
  states: {
    Flow: {
      states: {
        Routing: {
          choice: {
            branches: "routing",
            resolve: ({ containingState, select }) => {
              const score = containingState.score
              return score === 100
                ? select.perfect.decoded(new Approved({}))
                : score < 0
                ? select.negative.decoded(new Rejected({}))
                : score === 0
                ? select.zero.decoded(new Rejected({}))
                : score >= 70
                ? select.passing.decoded(new Approved({}))
                : select.failing.decoded(new Rejected({}))
            }
          }
        },
        Approved: {
          on: {
            Recheck: { initial: targets1.root.Flow, decoded: ({ event }) => (new Flow({ score: event.score })) }
          }
        }
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
      assert.strictEqual(plan.microsteps[0]?.transitions[0]?.branchIndex, 3)
      assert.strictEqual(plan.microsteps[0]?.transitions[0]?.branchKey, "passing")
      assert.strictEqual(Machine.isInitialEvent(plan.microsteps[0]!.event), true)
      assert.strictEqual(branchDeclarationReads, 1)
      const choice = Machine.transitionDefinitions(machine).find(({ source }) => source === "Flow.Routing")
      assert.deepStrictEqual(choice?.branches, [
        {
          type: "branch",
          key: "perfect",
          title: "Score is perfect",
          target: "Flow.Approved",
          selection: { path: "Flow.Approved", kind: "state", scope: "branch" },
          updates: []
        },
        {
          type: "branch",
          key: "negative",
          title: "Score is negative",
          target: "Flow.Rejected",
          selection: { path: "Flow.Rejected", kind: "state", scope: "branch" },
          updates: []
        },
        {
          type: "branch",
          key: "zero",
          title: "Score is zero",
          target: "Flow.Rejected",
          selection: { path: "Flow.Rejected", kind: "state", scope: "branch" },
          updates: []
        },
        {
          type: "branch",
          key: "passing",
          title: "Score is at least 70",
          target: "Flow.Approved",
          selection: { path: "Flow.Approved", kind: "state", scope: "branch" },
          updates: []
        },
        {
          type: "branch",
          key: "failing",
          title: "failing",
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
      }) {}
      class NestedFlow extends Schema.TaggedClass<NestedFlow>("ChoiceInputFlow")("ChoiceInputFlow", {
        score: Schema.Number
      }) {}
      const states = Machine.state({
        initial: "Root",
        states: {
          Root: {
            schema: Root,
            initial: "Flow",
            states: {
              Flow: {
                schema: NestedFlow,
                initial: "Routing",
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
      let observedContext: { readonly enabled: boolean; readonly score: number } | undefined
      const targets2 = Machine.targets(states)
      const inputChoice = Machine.make({
        branches: {
          transition1: {
            approved: { target: targets2.root.Root.Flow.Approved },
            rejected: { target: targets2.root.Root.Flow.Rejected }
          }
        },

        root: states,
        events: Machine.eventsFromSchemas(),
        input: Schema.Struct({ enabled: Schema.Boolean, score: Schema.Number }),
        initialConfiguration: (root) =>
          root.resolve(({ input, target }) =>
            target.from((to) =>
              to.Root.from(
                { enabled: input.enabled },
                (root) => root.Flow.from({ score: input.score }, (flow) => flow.Routing())
              )
            )
          )
      }).handle({
        states: {
          Root: {
            states: {
              Flow: {
                states: {
                  Routing: {
                    choice: {
                      branches: "transition1",
                      resolve: ({ ancestors, containingState, select }) => {
                        observedContext = {
                          enabled: ancestors.Root.enabled,
                          score: containingState.score
                        }
                        return ancestors.Root.enabled && containingState.score >= 70
                          ? select.approved.decoded(new Approved({}))
                          : select.rejected.decoded(new Rejected({}))
                      }
                    }
                  }
                }
              }
            }
          }
        }
      })

      const plan = yield* Machine.planInitial(inputChoice, { enabled: true, score: 80 })
      assert.deepStrictEqual(observedContext, { enabled: true, score: 80 })
      assert.strictEqual(plan.state.state.state.state.path, "Root.Flow.Approved")
      assert.strictEqual(plan.microsteps[0]?.transitions[0]?.branchKey, "approved")
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
        initial: "Flow",
        states: {
          Flow: {
            schema: Flow,
            initial: "First",
            states: {
              First: { type: "choice" },
              Second: { type: "choice" },
              Approved
            }
          }
        }
      })
      const targets3 = Machine.targets(states)
      const chained = Machine.make({
        branches: { transition1: { destination: { target: targets3.root.Flow.Second } } },

        root: states,
        events: Machine.eventsFromSchemas(),
        initialConfiguration: (root) =>
          root.resolve(({ target }) =>
            target.from((to) => to.Flow.decoded(new Flow({ score: 80 }), (flow) => flow.First()))
          )
      }).handle({
        states: {
          Flow: {
            states: {
              First: {
                choice: { branches: "transition1", resolve: ({ select: { destination: target } }) => target() }
              },
              Second: {
                choice: { target: targets3.root.Flow.Approved, decoded: () => (new Approved({})) }
              }
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
        initial: "Flow",
        states: {
          Flow: {
            schema: Flow,
            initial: "First",
            states: {
              First: { type: "choice" },
              Second: { type: "choice" },
              Approved
            }
          }
        }
      })
      const targets4 = Machine.targets(states)
      const looping = Machine.make({
        branches: {
          transition1: { destination: { target: targets4.root.Flow.Second } },
          transition2: { destination: { target: targets4.root.Flow.First } }
        },

        id: "ChoiceLoopMachine",
        root: states,
        events: Machine.eventsFromSchemas(),
        initialConfiguration: (root) =>
          root.resolve(({ target }) =>
            target.from((to) => to.Flow.decoded(new Flow({ score: 80 }), (flow) => flow.First()))
          )
      }).handle({
        states: {
          Flow: {
            states: {
              First: {
                choice: { branches: "transition1", resolve: ({ select: { destination: target } }) => target() }
              },
              Second: {
                choice: { branches: "transition2", resolve: ({ select: { destination: target } }) => target() }
              }
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
        initial: "Flow",
        states: {
          Flow: {
            schema: Flow,
            initial: "Approved",
            states: {
              Approved,
              Routing: { type: "choice" },
              Rejected
            }
          }
        }
      })
      const targets5 = Machine.targets(states)
      const alwaysMachine = Machine.make({
        branches: { transition1: { destination: { target: targets5.root.Flow.Routing } } },

        root: states,
        events: Machine.eventsFromSchemas(),
        initialConfiguration: (root) =>
          root.resolve(({ target }) =>
            target.from((to) =>
              to.Flow.decoded(new Flow({ score: 10 }), (flow) => flow.Approved.decoded(new Approved({})))
            )
          )
      }).handle({
        states: {
          Flow: {
            states: {
              Approved: {
                always: { branches: "transition1", resolve: ({ select: { destination: target } }) => target() }
              },
              Routing: {
                choice: { target: targets5.root.Flow.Rejected, decoded: () => (new Rejected({})) }
              }
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
      class Done extends Schema.TaggedClass<Done>("Done")("Done", {}) {}
      const states = Machine.state({
        initial: "Flow",
        states: {
          Flow: {
            schema: Flow,
            initial: "Done",
            states: {
              Done: { schema: Done, type: "final" },
              Routing: { type: "choice" },
              Rejected
            }
          }
        }
      })
      const targets6 = Machine.targets(states)
      const completion = Machine.make({
        branches: { transition1: { destination: { target: targets6.root.Flow } } },

        root: states,
        events: Machine.eventsFromSchemas(),
        initialConfiguration: (root) =>
          root.resolve(({ target }) =>
            target.from((to) => to.Flow.decoded(new Flow({ score: 0 }), (flow) => flow.Done.decoded(new Done({}))))
          )
      }).handle({
        states: {
          Flow: {
            onDone: {
              branches: "transition1",
              resolve: ({ state, select: { destination: target } }) => target.decoded(state, (flow) => flow.Routing())
            },
            states: {
              Routing: {
                choice: { target: targets6.root.Flow.Rejected, decoded: () => (new Rejected({})) }
              }
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
      class Board extends Schema.TaggedClass<Board>("Board")("Board", {}) {}
      class Left extends Schema.TaggedClass<Left>("Left")("Left", {}) {}
      class Ready extends Schema.TaggedClass<Ready>("Ready")("Ready", {}) {}
      class Right extends Schema.TaggedClass<Right>("Right")("Right", {}) {}
      class RightReady extends Schema.TaggedClass<RightReady>("RightReady")("RightReady", {}) {}
      const states = Machine.state({
        initial: "Board",
        states: {
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
        }
      })
      const targets7 = Machine.targets(states)
      const parallel = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas(),
        initialConfiguration: (root) =>
          root.resolve(({ target }) =>
            target.from((to) =>
              to.Board.decoded(new Board({}), (board) =>
                board
                  .Left.decoded(new Left({}), (left) => left.Routing())
                  .Right.decoded(new Right({}), (right) => right.Routing()))
            )
          )
      }).handle({
        states: {
          Board: {
            states: {
              Left: {
                states: {
                  Routing: {
                    choice: { target: targets7.root.Board.Left.Ready, decoded: () => (new Ready({})) }
                  }
                }
              },
              Right: {
                states: {
                  Routing: {
                    choice: { target: targets7.root.Board.Right.Ready, decoded: () => (new RightReady({})) }
                  }
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
      class Active extends Schema.TaggedClass<Active>("Active")("Active", {}) {}
      class Outside extends Schema.TaggedClass<Outside>("Outside")("Outside", {}) {}
      class Leave extends Schema.TaggedClass<Leave>("Leave")("Leave", {}) {}
      class Resume extends Schema.TaggedClass<Resume>("Resume")("Resume", {}) {}
      const states = Machine.state({
        initial: "Outside",
        states: {
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
        }
      })
      const targets8 = Machine.targets(states)
      const history = Machine.make({
        branches: {
          transition2: { destination: { history: targets8.root.Flow.Recent } },
          transition3: { destination: { target: targets8.root.Flow } }
        },

        root: states,
        events: Machine.eventsFromSchemas(Leave, Resume),
        initialConfiguration: (root) =>
          root.resolve(({ target }) =>
            target.from((to) => to.Flow.decoded(new Flow({ score: 1 }), (flow) => flow.Active.decoded(new Active({}))))
          )
      }).handle({
        states: {
          Flow: {
            history: {
              Recent: {
                default: ({ target }) =>
                  target.from((to) =>
                    to.Flow.decoded(new Flow({ score: 0 }), (flow) => flow.Active.decoded(new Active({})))
                  )
              }
            },
            states: {
              Active: {
                on: {
                  Leave: { target: targets8.root.Outside, decoded: () => (new Outside({})) }
                }
              },
              Routing: {
                choice: { branches: "transition2", resolve: ({ select: { destination: target } }) => target() }
              }
            }
          },
          Outside: {
            on: {
              Resume: {
                branches: "transition3",
                resolve: ({ select: { destination: target } }) =>
                  target.decoded(new Flow({ score: 2 }), (flow) => flow.Routing())
              }
            }
          }
        }
      })

      const initial = yield* Machine.planInitial(history)
      const outside = yield* Machine.plan(history, initial.state, new Leave({}))
      const resumed = yield* Machine.plan(history, outside.next, new Resume({}))
      assert.strictEqual(resumed.next.state.path, "Flow")
      if (resumed.next.state.path === "Flow") assert.strictEqual(resumed.next.state.state.path, "Flow.Active")
      assert.deepStrictEqual(resumed.microsteps[0]?.transitions.map(({ trigger }) => trigger.type), ["event", "choice"])
      const trace = yield* MachineTest.run(history, { events: [new Leave({}), new Resume({})] })
      yield* MachineTest.verify(history, trace, { laws: ["definitions"] })
    }))

  it.effect("uses a history default when an initial choice targets history", () =>
    Effect.gen(function*() {
      class Active extends Schema.TaggedClass<Active>("InitialHistoryActive")("InitialHistoryActive", {}) {}
      const states = Machine.state({
        initial: "Flow",
        states: {
          Flow: {
            schema: Flow,
            initial: "Routing",
            states: {
              Active,
              Routing: { type: "choice" },
              Recent: { type: "history" }
            }
          }
        }
      })
      const targets9 = Machine.targets(states)
      const initialHistory = Machine.make({
        branches: { transition1: { destination: { history: targets9.root.Flow.Recent } } },

        root: states,
        events: Machine.eventsFromSchemas(),
        initialConfiguration: (root) =>
          root.resolve(({ target }) =>
            target.from((to) => to.Flow.decoded(new Flow({ score: 1 }), (flow) => flow.Routing()))
          )
      }).handle({
        states: {
          Flow: {
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
              Routing: {
                choice: { branches: "transition1", resolve: ({ select: { destination: target } }) => target() }
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
      class Active extends Schema.TaggedClass<Active>("FallbackChoiceActive")("FallbackChoiceActive", {}) {}
      class Outside extends Schema.TaggedClass<Outside>("FallbackChoiceOutside")("FallbackChoiceOutside", {}) {}
      class Resume extends Schema.TaggedClass<Resume>("FallbackChoiceResume")("FallbackChoiceResume", {}) {}
      const states = Machine.state({
        initial: "Outside",
        states: {
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
        }
      })
      const targets10 = Machine.targets(states)
      const historyChoice = Machine.make({
        branches: { transition2: { destination: { history: targets10.root.Flow.Recent } } },

        root: states,
        events: Machine.eventsFromSchemas(Resume),
        initialConfiguration: (root) =>
          root.resolve(({ target }) => target.from((to) => to.Outside.decoded(new Outside({}))))
      }).handle({
        states: {
          Flow: {
            history: {
              Recent: {
                default: ({ target }) =>
                  target.from((to) => to.Flow.decoded(new Flow({ score: 1 }), (flow) => flow.Routing()))
              }
            },
            states: {
              Routing: {
                choice: { target: targets10.root.Flow.Active, decoded: () => (new Active({})) }
              }
            }
          },
          Outside: {
            on: {
              FallbackChoiceResume: {
                branches: "transition2",
                resolve: ({ select: { destination: target } }) => target()
              }
            }
          }
        }
      })

      const initial = yield* Machine.planInitial(historyChoice)
      const resumed = yield* Machine.plan(historyChoice, initial.state, new Resume({}))
      assert.strictEqual(resumed.next.state.path, "Flow")
      if (resumed.next.state.path === "Flow") assert.strictEqual(resumed.next.state.state.path, "Flow.Active")
      assert.deepStrictEqual(
        resumed.microsteps[0]?.transitions.map(({ source, trigger }) => ({ source, trigger: trigger.type })),
        [
          { source: "Outside", trigger: "event" },
          { source: "Flow.Routing", trigger: "choice" }
        ]
      )
      const historyDefinition = Machine.transitionDefinitions(historyChoice).find(
        ({ source, trigger }) =>
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
        branches: [
          {
            type: "branch",
            key: "perfect",
            title: "Score is perfect",
            target: "Flow.Approved",
            selection: { path: "Flow.Approved", kind: "state", scope: "branch" },
            updates: []
          },
          {
            type: "branch",
            key: "negative",
            title: "Score is negative",
            target: "Flow.Rejected",
            selection: { path: "Flow.Rejected", kind: "state", scope: "branch" },
            updates: []
          },
          {
            type: "branch",
            key: "zero",
            title: "Score is zero",
            target: "Flow.Rejected",
            selection: { path: "Flow.Rejected", kind: "state", scope: "branch" },
            updates: []
          },
          {
            type: "branch",
            key: "passing",
            title: "Score is at least 70",
            target: "Flow.Approved",
            selection: { path: "Flow.Approved", kind: "state", scope: "branch" },
            updates: []
          },
          {
            type: "branch",
            key: "failing",
            title: "failing",
            target: "Flow.Rejected",
            selection: { path: "Flow.Rejected", kind: "state", scope: "branch" },
            updates: []
          }
        ]
      }
    ])
    const recheck = definitions.find(
      ({ source, trigger }) => source === "Flow.Approved" && trigger.type === "event" && trigger.event === "Recheck"
    )
    assert.deepStrictEqual(recheck?.branches[0]?.selection, {
      path: "Flow",
      kind: "initial",
      scope: "branch"
    })
  })

  it.effect("attributes choice microsteps in MachineTest traces and coverage", () =>
    Effect.gen(function*() {
      const trace = yield* MachineTest.run(machine, { events: [new Recheck({ score: 10 })] })
      const coverage = MachineTest.coverage(machine, trace)
      assert.strictEqual(coverage.microsteps.choiceTriggered, 2)
      const choiceBranches = coverage.transitions.branches.hits.filter(({ trigger }) => trigger.type === "choice")
      assert.deepStrictEqual(choiceBranches.map(({ branchIndex }) => branchIndex), [3, 4])
      assert.deepStrictEqual(
        coverage.transitions.branches.misses
          .filter(({ trigger }) => trigger.type === "choice")
          .map(({ branchIndex }) => branchIndex),
        [0, 1, 2]
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
