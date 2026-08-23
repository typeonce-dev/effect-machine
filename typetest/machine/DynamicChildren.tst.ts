import { Effect, Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"

describe("dynamic child machines", () => {
  class ChildIdle extends Schema.TaggedClass<ChildIdle>("DynamicTypesChildIdle")("ChildIdle", {
    id: Schema.String
  }) {}
  class ChildEvent extends Schema.TaggedClass<ChildEvent>("DynamicTypesChildEvent")("ChildEvent", {}) {}
  class ParentNotice extends Schema.TaggedClass<ParentNotice>("DynamicTypesParentNotice")("ParentNotice", {}) {}
  class OtherEvent extends Schema.TaggedClass<OtherEvent>("DynamicTypesOtherEvent")("OtherEvent", {}) {}
  class ParentIdle extends Schema.TaggedClass<ParentIdle>("DynamicTypesParentIdle")("ParentIdle", {}) {}

  const Input = Schema.Struct({ id: Schema.String })
  const ParentEvents = Machine.events(ParentNotice)
  const childMachine = Machine.make({
    states: { ChildIdle },
    events: Machine.events(ChildEvent),
    input: Input,
    parent: Machine.parent(ParentEvents),
    initial: (to) => to.ChildIdle().resolve(({ input, target }) => target.decoded(new ChildIdle({ id: input.id })))
  }).handle({
    ChildIdle: {
      on: { ChildEvent: (to) => to.none }
    }
  })
  const Child = Machine.childFamily(childMachine)
  const voidChildMachine = Machine.make({
    states: { ChildIdle },
    events: Machine.events(),
    initial: (to) => to.ChildIdle().resolve(({ target }) => target.decoded(new ChildIdle({ id: "void" })))
  }).handle({ ChildIdle: {} })
  const VoidChild = Machine.childFamily(voidChildMachine)

  it("binds one machine type to runtime ids", () => {
    expect(Child("p-1")).type.toBe<Machine.ChildMachine<"p-1", typeof childMachine>>()
    expect(Child("p-1")).type.toBeAssignableTo(Machine.child("p-1", childMachine))
    expect(Child("p-1").id).type.toBe<"p-1">()
    expect(Child("p-1").machine).type.toBe<typeof childMachine>()
  })

  it("types statechart-owned dynamic child operations", () => {
    Machine.make({
      states: { ParentIdle },
      events: Machine.events(ParentNotice, OtherEvent),
      initial: (to) => to.ParentIdle().resolve(({ target }) => target.decoded(new ParentIdle({})))
    }).handle({
      ParentIdle: {
        invoke: (from) =>
          from.effect("spawn", ({ children }) => {
            expect(children.spawn).type.toBeCallableWith(Child("p-1"), { input: { id: "p-1" } })
            expect(children.spawn).type.not.toBeCallableWith(Child("p-1"))
            expect(children.spawn).type.toBeCallableWith(VoidChild("void"))
            expect(children.spawn).type.not.toBeCallableWith(VoidChild("void"), { input: { id: "void" } })
            expect(children.spawn).type.not.toBeCallableWith(
              Child("erased") as Machine.ChildMachine.Any,
              { input: { id: "erased" } }
            )
            expect(children.sendTo).type.toBeCallableWith(Child("p-1"), new ChildEvent({}))
            expect(children.sendTo).type.not.toBeCallableWith(Child("p-1"), new ParentNotice({}))
            expect(children.stop).type.toBeCallableWith(Child("p-1"))

            const spawned = children.spawn(Child("p-1"), { input: { id: "p-1" } })
            expect<Effect.Success<typeof spawned>>().type.toBe<Machine.ChildMachine.Ref<ReturnType<typeof Child>>>()
            expect<Effect.Error<typeof spawned>>().type.toBe<
              Machine.ChildAlreadyExistsError | Machine.ChildMachine.StartError<ReturnType<typeof Child>>
            >()
            return spawned
          }).onDone((to) => to.none).onFailure((to) => to.none)
      }
    })
  })

  it("rejects a child whose parent protocol is not accepted", () => {
    Machine.make({
      states: { ParentIdle },
      events: Machine.events(OtherEvent),
      initial: (to) => to.ParentIdle().resolve(({ target }) => target.decoded(new ParentIdle({})))
    }).handle({
      ParentIdle: {
        invoke: (from) =>
          from.effect("incompatible", ({ children }) => {
            expect(children.spawn).type.not.toBeCallableWith(Child("p-1"), { input: { id: "p-1" } })
            return Effect.void
          }).onDone((to) => to.none)
      }
    })
  })

  it("adds child descriptors to process spawn interfaces", () => {
    Machine.logic<undefined, ParentNotice>({
      initial: ({ spawn }) => {
        expect(spawn).type.toBeCallableWith(Child("p-1"), { input: { id: "p-1" } })
        return Effect.succeed(undefined)
      },
      run: () => Effect.never
    })

    Machine.logic<undefined, OtherEvent>({
      initial: ({ spawn }) => {
        expect(spawn).type.not.toBeCallableWith(Child("p-1"), { input: { id: "p-1" } })
        return Effect.succeed(undefined)
      },
      run: () => Effect.never
    })
  })
})
