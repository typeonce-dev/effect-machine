import { Effect, Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"
describe("dynamic child machines", () => {
  class ChildIdle extends Schema.TaggedClass<ChildIdle>("DynamicTypesChildIdle")("ChildIdle", {
    id: Schema.String
  }) {
  }
  class ChildEvent extends Schema.TaggedClass<ChildEvent>("DynamicTypesChildEvent")("ChildEvent", {}) {
  }
  class ParentNotice extends Schema.TaggedClass<ParentNotice>("DynamicTypesParentNotice")("ParentNotice", {}) {
  }
  class OtherEvent extends Schema.TaggedClass<OtherEvent>("DynamicTypesOtherEvent")("OtherEvent", {}) {
  }
  class ParentIdle extends Schema.TaggedClass<ParentIdle>("DynamicTypesParentIdle")("ParentIdle", {}) {
  }
  const Input = Schema.Struct({ id: Schema.String })
  const ParentEvents = Machine.eventsFromSchemas(ParentNotice)
  const root1 = Machine.state({
    fields: {
      input: Schema.toType(Input)
    },
    states: { ChildIdle }
  })
  const childMachine = Machine.make({
    root: root1,
    events: Machine.eventsFromSchemas(ChildEvent),
    input: Input,
    parent: Machine.parent(ParentEvents)
  }).handle({
    initial: {
      target: Machine.targets(root1).root.ChildIdle,
      decoded: true,
      data: ({ root: { input: input } }) => new ChildIdle({ id: input.id })
    },
    root: ({ input }) => ({ input }),
    states: { ChildIdle: { on: { ChildEvent: { none: true } } } }
  })
  const Child = Machine.childFamily(childMachine)
  const InitialRoot1 = Machine.state({ states: { ChildIdle } })
  const voidChildMachine = Machine.make({
    root: InitialRoot1,
    events: Machine.eventsFromSchemas()
  }).handle({
    initial: {
      target: Machine.targets(InitialRoot1).root.ChildIdle,
      decoded: true,
      data: new ChildIdle({ id: "void" })
    },
    states: { ChildIdle: {} }
  })
  const VoidChild = Machine.childFamily(voidChildMachine)
  it("binds one machine type to runtime ids", () => {
    expect(Child("p-1")).type.toBe<Machine.ChildMachine<"p-1", typeof childMachine>>()
    expect(Child("p-1")).type.toBeAssignableTo(Machine.child("p-1", childMachine))
    expect(Child("p-1").id).type.toBe<"p-1">()
    expect(Child("p-1").machine).type.toBe<typeof childMachine>()
  })
  it("types statechart-owned dynamic child operations", () => {
    const root2 = Machine.state({ states: { ParentIdle } })
    Machine.make({
      effects: {
        source1: ({ children }: Machine.Machine.InvokeContext<
          {
            readonly "": {
              readonly initial: "ParentIdle"
              readonly states: {
                readonly ParentIdle: typeof ParentIdle
              }
            } & {
              readonly "~effect/Machine/ExplicitInitial": true
            }
          },
          readonly [
            typeof ParentNotice,
            typeof OtherEvent
          ],
          readonly [],
          "ParentIdle",
          readonly [
            typeof ParentNotice,
            typeof OtherEvent
          ],
          readonly []
        >) => {
          expect(children.spawn).type.toBeCallableWith(Child("p-1"), { input: { id: "p-1" } })
          expect(children.spawn).type.not.toBeCallableWith(Child("p-1"))
          expect(children.spawn).type.toBeCallableWith(VoidChild("void"))
          expect(children.spawn).type.not.toBeCallableWith(VoidChild("void"), { input: { id: "void" } })
          expect(children.spawn).type.not.toBeCallableWith(Child("erased") as Machine.ChildMachine.Any, {
            input: { id: "erased" }
          })
          expect(children.sendTo).type.toBeCallableWith(Child("p-1"), new ChildEvent({}))
          expect(children.sendTo).type.not.toBeCallableWith(Child("p-1"), new ParentNotice({}))
          expect(children.stop).type.toBeCallableWith(Child("p-1"))
          const spawned = children.spawn(Child("p-1"), { input: { id: "p-1" } })
          expect<Effect.Success<typeof spawned>>().type.toBe<Machine.ChildMachine.Ref<ReturnType<typeof Child>>>()
          expect<Effect.Error<typeof spawned>>().type.toBe<
            Machine.ChildAlreadyExistsError | Machine.ChildMachine.StartError<ReturnType<typeof Child>>
          >()
          return spawned
        }
      },
      root: root2,
      events: Machine.eventsFromSchemas(ParentNotice, OtherEvent)
    }).handle({
      initial: {
        target: Machine.targets(root2).root.ParentIdle,
        decoded: true,
        data: new ParentIdle({})
      },
      states: {
        ParentIdle: {
          invoke: {
            src: "source1",
            id: "spawn",
            input: (context) => context,
            onDone: { none: true },
            onFailure: { none: true }
          }
        }
      }
    })
  })
  it("rejects a child whose parent protocol is not accepted", () => {
    const root3 = Machine.state({ states: { ParentIdle } })
    Machine.make({
      effects: {
        source1: ({ children }: Machine.Machine.InvokeContext<
          {
            readonly "": {
              readonly initial: "ParentIdle"
              readonly states: {
                readonly ParentIdle: typeof ParentIdle
              }
            } & {
              readonly "~effect/Machine/ExplicitInitial": true
            }
          },
          readonly [
            typeof OtherEvent
          ],
          readonly [],
          "ParentIdle",
          readonly [
            typeof OtherEvent
          ],
          readonly []
        >) => {
          expect(children.spawn).type.not.toBeCallableWith(Child("p-1"), { input: { id: "p-1" } })
          return Effect.void
        }
      },
      root: root3,
      events: Machine.eventsFromSchemas(OtherEvent)
    }).handle({
      initial: {
        target: Machine.targets(root3).root.ParentIdle,
        decoded: true,
        data: new ParentIdle({})
      },
      states: {
        ParentIdle: {
          invoke: {
            src: "source1",
            id: "incompatible",
            input: (context) => context,
            onDone: { none: true }
          }
        }
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
