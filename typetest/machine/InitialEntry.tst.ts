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
  initial: () => States.initial.closed(new Closed({}))
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
type OpenedInitializeContext = Machine.Machine.StateInitializeContext<
  typeof States.states,
  Events,
  readonly [],
  "opened"
>

describe("declared initial entry types", () => {
  it("requires initialize at the handle call that returns an initial target", () => {
    expect(base.handle).type.not.toBeCallableWith({
      closed: {
        on: {
          Open: ({ target }: ClosedContext) => target.full.opened.initial(new Opened({ id: "team-1" }))
        }
      },
      opened: {}
    })

    expect(base.handle).type.toBeCallableWith({
      closed: {
        on: {
          Open: ({ target }: ClosedContext) => target.full.opened.initial.from({ id: "team-1" })
        }
      },
      opened: {
        initialize: ({ builder }: OpenedInitializeContext) => builder.from({ count: 0 })
      }
    })

    expect(base.handle).type.toBeCallableWith({
      closed: {
        on: {
          Open: ({ target }: ClosedContext) =>
            target.full.opened(
              new Opened({ id: "team-1" }),
              (opened) => opened.loading(new Loading({}))
            )
        }
      },
      opened: {}
    })
  })

  it("only exposes initial on compound and parallel state builders", () => {
    base.handle({
      closed: {
        on: {
          Open: ({ target }) => {
            expect(target.full.closed).type.not.toHaveProperty("initial")
            expect(target.full.opened).type.toHaveProperty("initial")
            expect(target.full.opened.initial).type.not.toBeCallableWith()
            expect(target.full.opened.initial).type.toBeCallableWith(new Opened({ id: "team-1" }))
            expect(target.full.opened.initial.from).type.toBeCallableWith({ id: "team-1" })
            return target.full.opened(
              new Opened({ id: "team-1" }),
              (opened) => opened.loading(new Loading({}))
            )
          }
        }
      }
    })
  })
})
