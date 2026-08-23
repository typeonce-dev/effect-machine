import { Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"

class Root extends Schema.TaggedClass<Root>("Root")("Root", { revision: Schema.Number }) {}
class Work extends Schema.TaggedClass<Work>("Work")("Work", { revision: Schema.Number }) {}
class Auth extends Schema.TaggedClass<Auth>("Auth")("Auth", { user: Schema.String }) {}
class Sync extends Schema.TaggedClass<Sync>("Sync")("Sync", { cursor: Schema.Number }) {}
class SignedOut extends Schema.TaggedClass<SignedOut>("SignedOut")("SignedOut", {}) {}
class SignedIn extends Schema.TaggedClass<SignedIn>("SignedIn")("SignedIn", {}) {}
class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
class Tick extends Schema.TaggedClass<Tick>("Tick")("Tick", {}) {}

const States = Machine.states({
  root: {
    schema: Root,
    initial: "work",
    states: {
      work: {
        schema: Work,
        type: "parallel",
        states: {
          auth: {
            schema: Auth,
            initial: "signedOut",
            states: { signedOut: SignedOut, signedIn: { schema: SignedIn, type: "final" } }
          },
          sync: {
            schema: Sync,
            initial: "idle",
            states: { idle: Idle }
          }
        }
      },
      routing: { type: "choice" }
    }
  },
  structural: {
    initial: "idle",
    states: { idle: Idle }
  }
})

describe("Machine state-value updates", () => {
  it("exposes updates only for the valued active ancestor chain", () => {
    const machine = Machine.make({
      states: States.states,
      events: Machine.events(Tick),
      initial: (to) =>
        to.root.initial.resolve(({ target }) =>
          target.decoded(new Root({ revision: 0 }), (root) =>
            root.work.decoded(
              new Work({ revision: 0 }),
              (work) =>
                work.auth.decoded(
                  new Auth({ user: "" }),
                  (auth) => auth.signedOut.decoded(new SignedOut({}))
                )
                  .sync.decoded(new Sync({ cursor: 0 }), (sync) => sync.idle.decoded(new Idle({})))
            ))
        )
    })

    machine.handle({
      root: {
        states: {
          work: {
            states: {
              auth: {
                states: {
                  signedOut: {
                    on: {
                      Tick: (to) => {
                        expect(to.local).type.toHaveProperty("update")
                        expect(to.local.update).type.not.toHaveProperty("resolve")
                        expect(to.branch.root).type.toHaveProperty("update")
                        expect(to.branch.root.work).type.toHaveProperty("update")
                        expect(to.branch.root.work.auth).type.toHaveProperty("update")
                        expect(to.branch.root.work.auth.signedOut).type.not.toHaveProperty("update")
                        expect(to.branch.root.work.sync).type.not.toHaveProperty("update")
                        expect(to.full).type.not.toHaveProperty("update")
                        expect(to.history).type.not.toHaveProperty("update")
                        expect(to.none).type.not.toHaveProperty("update")

                        return to.local.update(({ current, owner, state }) => {
                          expect(state).type.toBe<SignedOut>()
                          expect(current).type.toBe<Auth>()
                          expect(owner.decoded).type.toBeCallableWith(new Auth({ user: "next" }))
                          expect(owner.from).type.toBeCallableWith({ user: "next" })
                          return owner.decoded(new Auth({ user: "next" }))
                        }, { reenter: true })
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    })
  })

  it("requires a declared retained owner to be replaced by the combined resolver", () => {
    const transition = null as unknown as Machine.Machine.TransitionSelector<
      typeof States.states,
      readonly [typeof Tick],
      readonly [],
      "root.work.auth.signedOut",
      Machine.Machine.HandlerContext<
        typeof States.states,
        readonly [typeof Tick],
        readonly [],
        "root.work.auth.signedOut",
        "Tick",
        never,
        never
      >,
      false,
      "required"
    >

    transition.local.signedIn()
      .updating(transition.branch.root.work.auth)
      .resolve(({ current, owner, target }) => {
        expect(current).type.toBe<Auth>()
        expect(owner.from).type.toBeCallableWith({ user: "next" })
        expect(owner.decoded).type.toBeCallableWith(new Auth({ user: "next" }))
        // @ts-expect-error! Decoded construction is named and the target itself is not callable.
        target(new SignedIn({}))
        expect(target.from).type.toBeCallableWith({})
        expect(target.decoded).type.toBeCallableWith(new SignedIn({}))
        return target.decoded(new SignedIn({})).update(
          owner.decoded(new Auth({ user: "next" }))
        )
      })

    transition.local.signedIn()
      .updating(transition.branch.root.work.auth)
      .resolve(
        // @ts-expect-error! Declaring `.updating(...)` requires the resolver to finish with `.update(...)`.
        ({ target }) => target.decoded(new SignedIn({}))
      )

    transition.local.signedIn().updating(
      // @ts-expect-error! The sibling sync owner does not contain the source and destination.
      transition.branch.root.work.sync
    )

    expect(transition.branches).type.not.toBeCallableWith({
      changed: {
        target: transition.local.signedIn().updating(transition.branch.root.work.auth)
      }
    })

    expect(transition.full.structural()).type.not.toHaveProperty("updating")
  })

  it("supports named update branches and rejects missing update evidence", () => {
    const update = null as unknown as Machine.Machine.TransitionSelector<
      typeof States.states,
      readonly [typeof Tick],
      readonly [],
      "root.work.auth.signedOut",
      Machine.Machine.HandlerContext<
        typeof States.states,
        readonly [typeof Tick],
        readonly [],
        "root.work.auth.signedOut",
        "Tick",
        never,
        never
      >,
      true,
      "required" | "declinable"
    >

    update.branches({
      changed: { target: update.branch.root.update, title: "Root changed" },
      unchanged: { target: update.none }
    }).resolve(({ select }) => select.changed.from({ revision: 1 }))

    update.local.update(({ owner }) => owner.from({ user: "next" }), { declinable: true })
    update.local.update(({ decline }) => decline(), { declinable: true })

    update.local.update(
      // @ts-expect-error!
      () => new Auth({ user: "next" })
    )
    update.local.update(
      // @ts-expect-error!
      () => undefined
    )
  })

  it("omits updates from structural scopes and choice resolvers", () => {
    type StructuralSelector = Machine.Machine.TransitionSelector<
      typeof States.states,
      readonly [typeof Tick],
      readonly [],
      "structural.idle",
      Machine.Machine.HandlerContext<
        typeof States.states,
        readonly [typeof Tick],
        readonly [],
        "structural.idle",
        "Tick",
        never,
        never
      >,
      true,
      "required"
    >
    const structural = null as unknown as StructuralSelector
    expect(structural.local).type.not.toHaveProperty("update")
    expect(structural.branch.structural).type.not.toHaveProperty("update")

    type ChoiceSelector = Machine.Machine.TransitionSelector<
      typeof States.states,
      readonly [typeof Tick],
      readonly [],
      "root.routing",
      Machine.Machine.ChoiceContext<typeof States.states, readonly [typeof Tick], readonly [], "root.routing">,
      false,
      "required"
    >
    const choice = null as unknown as ChoiceSelector
    expect(choice.local).type.not.toHaveProperty("update")
    expect(choice.branch.root).type.not.toHaveProperty("update")

    type FinalSelector = Machine.Machine.TransitionSelector<
      typeof States.states,
      readonly [typeof Tick],
      readonly [],
      "root.work.auth.signedIn",
      Machine.Machine.HandlerContext<
        typeof States.states,
        readonly [typeof Tick],
        readonly [],
        "root.work.auth.signedIn",
        "Tick",
        never,
        never
      >,
      true,
      "required"
    >
    const final = null as unknown as FinalSelector
    expect(final.branch.root.work.auth.signedIn).type.not.toHaveProperty("update")
    expect(final.branch.root.work.auth).type.toHaveProperty("update")
  })
})
