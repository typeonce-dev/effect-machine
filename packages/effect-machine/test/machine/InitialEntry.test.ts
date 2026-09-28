import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Machine } from "../../src/index.js"
class Closed extends Schema.TaggedClass<Closed>("InitialEntryClosed")("Closed", {}) {}
class Opened extends Schema.TaggedClass<Opened>("InitialEntryOpened")("Opened", {
  id: Schema.NonEmptyString
}) {}
class Idle extends Schema.TaggedClass<Idle>("InitialEntryIdle")("Idle", {
  count: Schema.NumberFromString
}) {}
class Loading extends Schema.TaggedClass<Loading>("InitialEntryLoading")("Loading", {}) {}
class Open extends Schema.TaggedClass<Open>("InitialEntryOpen")("Open", {}) {}
class OpenInvalid extends Schema.TaggedClass<OpenInvalid>("InitialEntryOpenInvalid")("OpenInvalid", {}) {}
class Outside extends Schema.TaggedClass<Outside>("InitialEntryOutside")("Outside", {}) {}
class Dashboard extends Schema.TaggedClass<Dashboard>("InitialEntryDashboard")("Dashboard", {}) {}
class Filters extends Schema.TaggedClass<Filters>("InitialEntryFilters")("Filters", { id: Schema.String }) {}
class Ready extends Schema.TaggedClass<Ready>("InitialEntryReady")("Ready", { enabled: Schema.Boolean }) {}
class Results extends Schema.TaggedClass<Results>("InitialEntryResults")("Results", { count: Schema.Number }) {}
class EnterDashboard extends Schema.TaggedClass<EnterDashboard>("InitialEntryEnterDashboard")("EnterDashboard", {}) {}
class Flow extends Schema.TaggedClass<Flow>("InitialEntryFlow")("Flow", {}) {}
class Approved extends Schema.TaggedClass<Approved>("InitialEntryApproved")("Approved", {}) {}
class EnterFlow extends Schema.TaggedClass<EnterFlow>("InitialEntryEnterFlow")("EnterFlow", {}) {}
class OpenLocal extends Schema.TaggedClass<OpenLocal>("InitialEntryOpenLocal")("OpenLocal", {}) {}
class OpenBranch extends Schema.TaggedClass<OpenBranch>("InitialEntryOpenBranch")("OpenBranch", {}) {}
const States = Machine.state({
  states: {
    closed: Closed,
    opened: {
      schema: Opened,
      states: {
        idle: Idle,
        loading: Loading
      }
    }
  }
})
const makeMachine = () => {
  return Machine.make({
    root: States,
    events: Machine.eventsFromSchemas(Open, OpenInvalid)
  }).handle({
    initial: {
      target: "closed",
      decoded: true,
      data: new Closed({})
    },
    states: {
      closed: {
        on: {
          Open: { target: "opened", data: () => ({ id: "team-1" }) },
          OpenInvalid: { target: "opened", data: () => ({ id: "" }) }
        }
      },
      opened: {
        initial: {
          target: "opened.idle",
          data: ({}) => ({ count: 1 })
        },
        states: {
          idle: {},
          loading: {}
        }
      }
    }
  })
}
const ParallelStates = Machine.state({
  states: {
    outside: Outside,
    dashboard: {
      schema: Dashboard,
      type: "parallel",
      states: {
        filters: {
          schema: Filters,
          states: { ready: Ready }
        },
        results: Results
      }
    }
  }
})
const makeParallelMachine = () => {
  return Machine.make({
    root: ParallelStates,
    events: Machine.eventsFromSchemas(EnterDashboard)
  }).handle({
    initial: {
      target: "outside",
      decoded: true,
      data: new Outside({})
    },
    states: {
      outside: {
        on: {
          EnterDashboard: { target: "dashboard", decoded: true, data: () => (new Dashboard({})) }
        }
      },
      dashboard: {
        initial: { filters: ({}) => ({ id: "all" }), results: ({}) => ({ count: 2 }) },
        states: {
          filters: {
            initial: {
              target: "dashboard.filters.ready",
              data: ({}) => ({ enabled: true })
            },
            states: {
              ready: {}
            }
          },
          results: {}
        }
      }
    }
  })
}
const ChoiceStates = Machine.state({
  states: {
    outside: Outside,
    flow: {
      schema: Flow,
      states: {
        routing: { type: "choice" },
        approved: Approved
      }
    }
  }
})
const makeChoiceMachine = () => {
  return Machine.make({
    root: ChoiceStates,
    events: Machine.eventsFromSchemas(EnterFlow)
  }).handle({
    initial: {
      target: "outside",
      decoded: true,
      data: new Outside({})
    },
    states: {
      outside: {
        on: {
          EnterFlow: { target: "flow", decoded: true, data: () => (new Flow({})) }
        }
      },
      flow: {
        initial: {
          target: "flow.routing"
        },
        states: {
          routing: {
            choice: { target: "flow.approved", decoded: true, data: () => (new Approved({})) }
          },
          approved: {}
        }
      }
    }
  })
}
const StructuralStates = Machine.state({
  states: {
    outside: Outside,
    group: {
      states: { idle: {} }
    }
  }
})
const makeStructuralMachine = () => {
  return Machine.make({
    root: StructuralStates,
    events: Machine.eventsFromSchemas(EnterFlow)
  }).handle({
    initial: {
      target: "outside",
      decoded: true,
      data: new Outside({})
    },
    states: {
      outside: {
        on: {
          EnterFlow: { target: "group" }
        }
      },
      group: {
        initial: {
          target: "group.idle"
        },
        states: {
          idle: {}
        }
      }
    }
  })
}
const NestedStates = Machine.state({
  states: {
    main: {
      states: {
        closed: Closed,
        opened: {
          schema: Opened,
          states: { idle: Idle, loading: Loading }
        }
      }
    }
  }
})
const makeNestedMachine = () => {
  return Machine.make({
    root: NestedStates,
    events: Machine.eventsFromSchemas(OpenLocal, OpenBranch)
  }).handle({
    initial: {
      target: "main"
    },
    states: {
      main: {
        initial: {
          target: "main.closed",
          decoded: true,
          data: new Closed({})
        },
        states: {
          closed: {
            on: {
              OpenLocal: { target: "main.opened", data: () => ({ id: "local" }) },
              OpenBranch: { target: "main.opened", data: () => ({ id: "branch" }) }
            }
          },
          opened: {
            initial: {
              target: "main.opened.idle",
              data: ({}) => ({ count: 3 })
            },
            states: {
              idle: {},
              loading: {}
            }
          }
        }
      }
    }
  })
}
describe("declared initial entry", () => {
  it.effect("captures the initial target and evaluates construction only when planned", () =>
    Effect.gen(function*() {
      let resolves = 0
      const root = Machine.state({ states: { closed: Closed } })
      const target = "closed"
      const machine = Machine.make({ root, events: Machine.eventsFromSchemas() }).handle({
        initial: {
          target,
          data: () => {
            resolves++
            return {}
          }
        }
      })
      assert.strictEqual(resolves, 0)
      const first = yield* Machine.planInitial(machine)
      const second = yield* Machine.planInitial(machine)
      assert.deepStrictEqual(first.state.state, { path: "closed", value: new Closed({}) })
      assert.deepStrictEqual(second.state, first.state)
      assert.strictEqual(resolves, 2)
    }))
  it.effect("default-constructs a bare initial destination", () =>
    Effect.gen(function*() {
      const InitialRoot2 = Machine.state({ states: { closed: Closed } })
      const machine = Machine.make({
        root: InitialRoot2,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: "closed"
        },
        states: {
          closed: {}
        }
      })
      const initial = yield* Machine.planInitial(machine)
      assert.deepStrictEqual(initial.state.state, { path: "closed", value: new Closed({}) })
    }))
  it.effect("enters a compound state's declared initial child and decodes builder inputs", () =>
    Effect.gen(function*() {
      const machine = makeMachine()
      const initial = yield* Machine.planInitial(machine)
      const planned = yield* Machine.plan(machine, initial.state, new Open({}))
      assert.deepStrictEqual(planned.next.state, {
        path: "opened" as const,
        value: new Opened({ id: "team-1" }),
        state: { path: "opened.idle" as const, value: new Idle({ count: 1 }) }
      })
    }))
  it.effect("reports invalid initial target inputs as typed machine schema failures", () =>
    Effect.gen(function*() {
      const machine = makeMachine()
      const initial = yield* Machine.planInitial(machine)
      const error = yield* Machine.plan(machine, initial.state, new OpenInvalid({})).pipe(Effect.flip)
      assert.instanceOf(error, Machine.MachineSchemaDecodeError)
      assert.strictEqual(error.boundary, "state")
      assert.strictEqual(error.state, "opened")
    }))
  it.effect("initializes every parallel region fluently and recurses through nested defaults", () =>
    Effect.gen(function*() {
      const machine = makeParallelMachine()
      const initial = yield* Machine.planInitial(machine)
      const planned = yield* Machine.plan(machine, initial.state, new EnterDashboard({}))
      assert.deepStrictEqual(planned.next.state, {
        path: "dashboard" as const,
        value: new Dashboard({}),
        states: {
          filters: {
            path: "dashboard.filters" as const,
            value: new Filters({ id: "all" }),
            state: { path: "dashboard.filters.ready" as const, value: new Ready({ enabled: true }) }
          },
          results: { path: "dashboard.results" as const, value: new Results({ count: 2 }) }
        }
      })
    }))
  it.effect("routes a declared initial choice before activating the concrete child", () =>
    Effect.gen(function*() {
      const machine = makeChoiceMachine()
      const initial = yield* Machine.planInitial(machine)
      const planned = yield* Machine.plan(machine, initial.state, new EnterFlow({}))
      assert.deepStrictEqual(planned.next.state, {
        path: "flow" as const,
        value: new Flow({}),
        state: { path: "flow.approved" as const, value: new Approved({}) }
      })
      assert.deepStrictEqual(planned.microsteps[0]?.transitions, [{
        source: "outside",
        trigger: { type: "event", event: "EnterFlow" },
        reenter: false,
        branchIndex: 0,
        branchKey: undefined,
        target: "flow",
        resolvedTarget: "flow",
        updates: []
      }, {
        source: "flow.routing",
        trigger: { type: "choice" },
        reenter: false,
        branchIndex: 0,
        branchKey: undefined,
        target: "flow.approved",
        resolvedTarget: "flow.approved",
        updates: []
      }])
    }))
  it.effect("enters structural declared initial states without an initializer", () =>
    Effect.gen(function*() {
      const machine = makeStructuralMachine()
      const initial = yield* Machine.planInitial(machine)
      const planned = yield* Machine.plan(machine, initial.state, new EnterFlow({}))
      assert.deepStrictEqual(planned.next.state, {
        path: "group" as const,
        value: undefined,
        state: { path: "group.idle" as const, value: undefined }
      })
    }))
  it.effect("supports declared initial entry through local and branch target scopes", () =>
    Effect.gen(function*() {
      const machine = makeNestedMachine()
      const initial = yield* Machine.planInitial(machine)
      const local = yield* Machine.plan(machine, initial.state, new OpenLocal({}))
      const branch = yield* Machine.plan(machine, initial.state, new OpenBranch({}))
      for (const [planned, id] of [[local, "local"], [branch, "branch"]] as const) {
        assert.deepStrictEqual(planned.next.state, {
          path: "main" as const,
          value: undefined,
          state: {
            path: "main.opened" as const,
            value: new Opened({ id }),
            state: { path: "main.opened.idle" as const, value: new Idle({ count: 3 }) }
          }
        })
      }
    }))
})
