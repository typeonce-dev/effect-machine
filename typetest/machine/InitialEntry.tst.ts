import { Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"

class Closed extends Schema.TaggedClass<Closed>("InitialTypeClosed")("Closed", {}) {}
class Opened extends Schema.TaggedClass<Opened>("InitialTypeOpened")("Opened", { id: Schema.String }) {}
class Idle extends Schema.TaggedClass<Idle>("InitialTypeIdle")("Idle", { count: Schema.Number }) {}
class Loading extends Schema.TaggedClass<Loading>("InitialTypeLoading")("Loading", {}) {}
class Open extends Schema.TaggedClass<Open>("InitialTypeOpen")("Open", {}) {}

const States = Machine.defineStates({
  closed: Closed,
  opened: {
    schema: Opened,
    initial: "idle",
    states: { idle: Idle, loading: Loading }
  }
})

const base = Machine.make({
  states: States.states,
  events: Machine.events(Open),
  initial: {
    target: (to) => to.closed(),
    resolve: ({ target }) => (target(new Closed({})))
  }
})

type Events = readonly [typeof Open]
type ClosedContext = Machine.Machine.HandlerContext<
  typeof States.states,
  Events,
  readonly [],
  "closed",
  "Open",
  never,
  never
>
type ClosedTransition = Machine.Machine.TransitionConfig<
  typeof States.states,
  Events,
  readonly [],
  "closed",
  ClosedContext,
  true
>
type OpenedInitializeContext = Machine.Machine.StateInitializeContext<
  typeof States.states,
  Events,
  readonly [],
  "opened"
>

describe("declared initial entry types", () => {
  it("requires initialize at the handle call that returns an initial target", () => {
    const invalid = Machine.transition({
      target: (to) => to.full.opened.initial(),
      resolve: ({ target }) => target(new Opened({ id: "team-1" }))
    }) satisfies ClosedTransition
    expect(base.handle).type.not.toBeCallableWith({
      closed: {
        on: {
          Open: invalid
        }
      },
      opened: {}
    })

    const initial = Machine.transition({
      target: (to) => to.full.opened.initial(),
      resolve: ({ target }) => target.from({ id: "team-1" })
    }) satisfies ClosedTransition
    expect(base.handle).type.toBeCallableWith({
      closed: {
        on: {
          Open: initial
        }
      },
      opened: {
        initialize: ({ builder }: OpenedInitializeContext) => builder.from({ count: 0 })
      }
    })

    const explicit = Machine.transition({
      target: (to) => to.full.opened(),
      resolve: ({ target }) =>
        target(
          new Opened({ id: "team-1" }),
          (opened) => opened.loading(new Loading({}))
        )
    }) satisfies ClosedTransition
    expect(base.handle).type.toBeCallableWith({
      closed: {
        on: {
          Open: explicit
        }
      },
      opened: {}
    })
  })

  it("only exposes initial on compound and parallel state builders", () => {
    base.handle({
      closed: {
        on: {
          Open: Machine.transition({
            target: (to) => to.full.opened(),
            resolve: ({ target }) => {
              expect(target).type.toHaveProperty("initial")
              expect(target.initial).type.not.toBeCallableWith()
              expect(target.initial).type.toBeCallableWith(new Opened({ id: "team-1" }))
              expect(target.initial.from).type.toBeCallableWith({ id: "team-1" })
              return target(
                new Opened({ id: "team-1" }),
                (opened) => opened.loading(new Loading({}))
              )
            }
          })
        }
      }
    })
  })
})
