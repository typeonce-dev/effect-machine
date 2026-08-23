import { Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"

class Closed extends Schema.TaggedClass<Closed>("InitialTypeClosed")("Closed", {}) {}
class Opened extends Schema.TaggedClass<Opened>("InitialTypeOpened")("Opened", { id: Schema.String }) {}
class Idle extends Schema.TaggedClass<Idle>("InitialTypeIdle")("Idle", { count: Schema.Number }) {}
class Loading extends Schema.TaggedClass<Loading>("InitialTypeLoading")("Loading", {}) {}
class Open extends Schema.TaggedClass<Open>("InitialTypeOpen")("Open", {}) {}

const States = Machine.states({
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
  initial: (to) => to.closed().resolve(({ target }) => (target.decoded(new Closed({}))))
})

describe("declared initial entry types", () => {
  it("requires initialize at the handle call that returns an initial target", () => {
    base.handle({
      closed: {
        on: {
          Open: (to) => to.full.opened.initial.resolve(({ target }) => target.decoded(new Opened({ id: "team-1" })))
        }
      },
      // @ts-expect-error!
      opened: {}
    })

    base.handle({
      closed: {
        on: {
          Open: (to) => to.full.opened.initial.resolve(({ target }) => target.from({ id: "team-1" }))
        }
      },
      opened: {
        initialize: ({ builder }) => builder.from({ count: 0 })
      }
    })

    base.handle({
      closed: {
        on: {
          Open: (to) =>
            to.full.opened().resolve(({ target }) =>
              target.decoded(
                new Opened({ id: "team-1" }),
                (opened) => opened.loading.decoded(new Loading({}))
              )
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
          Open: (to) =>
            to.full.opened().resolve(({ target }) => {
              expect(to.full.opened.initial).type.not.toBeAssignableTo<() => unknown>()
              expect(target).type.toHaveProperty("initial")
              expect(target.initial.decoded).type.not.toBeCallableWith()
              expect(target.initial.decoded).type.toBeCallableWith(new Opened({ id: "team-1" }))
              expect(target.initial.from).type.toBeCallableWith({ id: "team-1" })
              return target.decoded(
                new Opened({ id: "team-1" }),
                (opened) => opened.loading.decoded(new Loading({}))
              )
            })
        }
      }
    })
  })
})
