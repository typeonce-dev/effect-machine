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

const States = Machine.states({
  closed: Closed,
  opened: {
    schema: Opened,
    initial: "idle",
    states: {
      idle: Idle,
      loading: Loading
    }
  }
})

const makeMachine = () =>
  Machine.make({
    states: States.states,
    events: Machine.events(Open, OpenInvalid),
    initial: (to) => to.closed().resolve(({ target }) => target(new Closed({})))
  }).handle({
    closed: {
      on: {
        Open: (to) => to.full.opened.initial.resolve(({ target }) => target.from({ id: "team-1" })),
        OpenInvalid: (to) => to.full.opened.initial.resolve(({ target }) => target.from({ id: "" }))
      }
    },
    opened: {
      initialize: ({ builder }) => builder.from({ count: 1 })
    }
  })

const ParallelStates = Machine.states({
  outside: Outside,
  dashboard: {
    schema: Dashboard,
    type: "parallel",
    states: {
      filters: {
        schema: Filters,
        initial: "ready",
        states: { ready: Ready }
      },
      results: Results
    }
  }
})

const makeParallelMachine = () =>
  Machine.make({
    states: ParallelStates.states,
    events: Machine.events(EnterDashboard),
    initial: (to) => to.outside().resolve(({ target }) => target(new Outside({})))
  }).handle({
    outside: {
      on: {
        EnterDashboard: (to) => to.full.dashboard.initial.resolve(({ target }) => target(new Dashboard({})))
      }
    },
    dashboard: {
      initialize: ({ builder }) => builder.filters.from({ id: "all" }).results.from({ count: 2 }),
      states: {
        filters: {
          initialize: ({ builder }) => builder.from({ enabled: true })
        }
      }
    }
  })

const ChoiceStates = Machine.states({
  outside: Outside,
  flow: {
    schema: Flow,
    initial: "routing",
    states: {
      routing: { type: "choice" },
      approved: Approved
    }
  }
})

const makeChoiceMachine = () =>
  Machine.make({
    states: ChoiceStates.states,
    events: Machine.events(EnterFlow),
    initial: (to) => to.outside().resolve(({ target }) => target(new Outside({})))
  }).handle({
    outside: {
      on: {
        EnterFlow: (to) => to.full.flow.initial.resolve(({ target }) => target(new Flow({})))
      }
    },
    flow: {
      states: {
        routing: {
          choice: (to) => to.local.approved().resolve(({ target }) => target(new Approved({})))
        }
      }
    }
  })

const StructuralStates = Machine.states({
  outside: Outside,
  group: {
    initial: "idle",
    states: { idle: {} }
  }
})

const makeStructuralMachine = () =>
  Machine.make({
    states: StructuralStates.states,
    events: Machine.events(EnterFlow),
    initial: (to) => to.outside().resolve(({ target }) => target(new Outside({})))
  }).handle({
    outside: {
      on: {
        EnterFlow: (to) => to.full.group.initial.resolve(({ target }) => target.from())
      }
    }
  })

const NestedStates = Machine.states({
  root: {
    initial: "closed",
    states: {
      closed: Closed,
      opened: {
        schema: Opened,
        initial: "idle",
        states: { idle: Idle, loading: Loading }
      }
    }
  }
})

const makeNestedMachine = () =>
  Machine.make({
    states: NestedStates.states,
    events: Machine.events(OpenLocal, OpenBranch),
    initial: (to) => to.root.initial.resolve(({ target }) => target.from((root) => root.closed(new Closed({}))))
  }).handle({
    root: {
      states: {
        closed: {
          on: {
            OpenLocal: (to) => to.local.opened.initial.resolve(({ target }) => target.from({ id: "local" })),
            OpenBranch: (to) => to.branch.root.opened.initial.resolve(({ target }) => target.from({ id: "branch" }))
          }
        },
        opened: {
          initialize: ({ builder }) => builder.from({ count: 3 })
        }
      }
    }
  })

describe("declared initial entry", () => {
  it.effect("captures the target-first selector once and evaluates its resolver only when planned", () =>
    Effect.gen(function*() {
      let captures = 0
      let resolves = 0
      const definition = Machine.make({
        states: { closed: Closed },
        events: Machine.events(),
        initial: (to) => {
          captures++
          return to.closed().resolve(({ target }) => {
            resolves++
            return target.from()
          })
        }
      })

      assert.strictEqual(captures, 1)
      assert.strictEqual(resolves, 0)

      const machine = definition.handle({ closed: {} })
      const first = yield* Machine.planInitial(machine)
      const second = yield* Machine.planInitial(machine)

      assert.deepStrictEqual(first.state, { path: "closed", value: new Closed({}) })
      assert.deepStrictEqual(second.state, first.state)
      assert.strictEqual(captures, 1)
      assert.strictEqual(resolves, 2)
    }))

  it.effect("default-constructs a bare initial destination", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        states: { closed: Closed },
        events: Machine.events(),
        initial: (to) => to.closed()
      }).handle({ closed: {} })

      const initial = yield* Machine.planInitial(machine)
      assert.deepStrictEqual(initial.state, { path: "closed", value: new Closed({}) })
    }))

  it.effect("enters a compound state's declared initial child and decodes builder inputs", () =>
    Effect.gen(function*() {
      const machine = makeMachine()
      const initial = yield* Machine.planInitial(machine)
      const planned = yield* Machine.plan(machine, initial.state, new Open({}))

      assert.deepStrictEqual(
        planned.next,
        {
          path: "opened" as const,
          value: new Opened({ id: "team-1" }),
          state: { path: "opened.idle" as const, value: new Idle({ count: 1 }) }
        }
      )
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

      assert.deepStrictEqual(
        planned.next,
        {
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
        }
      )
    }))

  it.effect("routes a declared initial choice before activating the concrete child", () =>
    Effect.gen(function*() {
      const machine = makeChoiceMachine()
      const initial = yield* Machine.planInitial(machine)
      const planned = yield* Machine.plan(machine, initial.state, new EnterFlow({}))

      assert.deepStrictEqual(
        planned.next,
        {
          path: "flow" as const,
          value: new Flow({}),
          state: { path: "flow.approved" as const, value: new Approved({}) }
        }
      )
      assert.deepStrictEqual(planned.microsteps[0]?.transitions, [{
        source: "outside",
        trigger: { type: "event", event: "EnterFlow" },
        reenter: false,
        branchIndex: 0,
        branchKey: undefined,
        target: "flow",
        resolvedTarget: "flow"
      }, {
        source: "flow.routing",
        trigger: { type: "choice" },
        reenter: false,
        branchIndex: 0,
        branchKey: undefined,
        target: "flow.approved",
        resolvedTarget: "flow.approved"
      }])
    }))

  it.effect("enters structural declared initial states without an initializer", () =>
    Effect.gen(function*() {
      const machine = makeStructuralMachine()
      const initial = yield* Machine.planInitial(machine)
      const planned = yield* Machine.plan(machine, initial.state, new EnterFlow({}))

      assert.deepStrictEqual(planned.next, {
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
        assert.deepStrictEqual(planned.next, {
          path: "root" as const,
          value: undefined,
          state: {
            path: "root.opened" as const,
            value: new Opened({ id }),
            state: { path: "root.opened.idle" as const, value: new Idle({ count: 3 }) }
          }
        })
      }
    }))
})
