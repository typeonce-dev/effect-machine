import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { Machine } from "../../src/index.js"
import { openWithRuntimeStrategy } from "../internal/machine/support/strategyDifferential.js"

const ParentEvents = Machine.events({ Finished: {} })

const ChildStates = Machine.state({
  fields: { id: Schema.String },
  states: { Idle: {}, Working: {}, Done: {} }
})
const ChildEvents = Machine.events({ Go: {} })

const makeChild = (work: Effect.Effect<void>) =>
  Machine.make({
    id: "child",
    root: ChildStates,
    events: ChildEvents,
    input: Schema.Struct({ id: Schema.String }),
    parent: Machine.parent(ParentEvents),
    effects: { work: (_: unknown) => work },
    branches: { finished: { done: { target: "Done" } } }
  }).handle({
    root: ({ input }) => input,
    initial: { target: "Idle" },
    states: {
      Idle: { on: { Go: { target: "Working" } } },
      Working: {
        invoke: {
          src: "work",
          input: ({ root }) => root,
          onDone: {
            branches: "finished",
            resolve: ({ parent, select }, enqueue) => {
              enqueue.sendTo(parent, ParentEvents.Finished())
              return select.done()
            }
          }
        }
      },
      Done: {}
    }
  })

const ParentStates = Machine.state({ states: { Hosting: {}, Left: {} } })

const makeParent = (work: Effect.Effect<void>) => {
  const Child = Machine.child("child", makeChild(work))
  return {
    Child,
    machine: Machine.make({
      root: ParentStates,
      events: ParentEvents,
      children: { child: Child }
    }).handle({
      initial: { target: "Hosting" },
      states: {
        Hosting: {
          invoke: { src: "child", input: () => ({ id: "a" }) },
          on: { Finished: { target: "Left" } }
        },
        Left: {}
      }
    })
  }
}

// The child's worker starts in the turn of the invocation that completes, so
// stopping the child from that turn must not wait for the invocation.
describe("a child invocation's onDone notifies a parent that stops the child", () => {
  for (
    const [name, work] of [
      ["synchronous", Effect.void],
      ["asynchronous", Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 10)))]
    ] as const
  ) {
    for (const strategy of ["generic", "compiled"] as const) {
      it.live(`${name} invocation, ${strategy} parent`, () =>
        Effect.gen(function*() {
          const { Child, machine: definition } = makeParent(work)
          const machine = yield* openWithRuntimeStrategy(definition, strategy)
          const child = Option.getOrThrow(yield* machine.child(Child))
          yield* child.send(ChildEvents.Go())
          yield* Machine.waitFor(machine, (snapshot) => ParentStates.matches(snapshot.state, "Left"))
          expect(Option.isNone(yield* machine.child(Child))).toBe(true)
        }).pipe(Effect.scoped, Effect.timeout("2 seconds")))
    }
  }
})
