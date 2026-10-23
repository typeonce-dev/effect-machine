import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Schema, Stream } from "effect"
import { Machine } from "../../src/index.js"
class Editing extends Schema.TaggedClass<Editing>("SynchronousDeliveryEditing")("Editing", {
  value: Schema.String
}) {}
class Saving extends Schema.TaggedClass<Saving>("SynchronousDeliverySaving")("Saving", {
  value: Schema.String
}) {}
class Saved extends Schema.TaggedClass<Saved>("SynchronousDeliverySaved")("Saved", {
  value: Schema.String
}) {}
class Changed extends Schema.TaggedClass<Changed>("SynchronousDeliveryChanged")("Changed", {
  value: Schema.String
}) {}
class Pasted extends Schema.TaggedClass<Pasted>("SynchronousDeliveryPasted")("Pasted", {
  value: Schema.String
}) {}
class Save extends Schema.TaggedClass<Save>("SynchronousDeliverySave")("Save", {}) {}
class Normalized extends Schema.TaggedClass<Normalized>("SynchronousDeliveryNormalized")("Normalized", {
  value: Schema.String
}) {}
class Published extends Schema.TaggedClass<Published>("SynchronousDeliveryPublished")("Published", {
  value: Schema.String
}) {}

const Emissions = Machine.emittedEventsFromSchemas(Published)

const editing = {
  on: {
    // A plain transition, as a controlled input sends on every keystroke.
    Changed: {
      target: "Editing",
      decoded: true,
      data: ({ event }: { readonly event: Changed }) => new Editing({ value: event.value })
    },
    // The committed value comes from a raised event, so observing it requires
    // the whole macrostep, including its emission, to have run.
    Pasted: {
      none: true,
      resolve: ({ event }: { readonly event: Pasted }, enqueue: Machine.Enqueue<Normalized, Published>) => {
        const value = event.value.trim()
        enqueue.raise(new Normalized({ value }))
        enqueue.emit(Emissions.Published({ value }))
        return undefined
      }
    },
    Normalized: {
      target: "Editing",
      decoded: true,
      data: ({ event }: { readonly event: Normalized }) => new Editing({ value: event.value })
    }
  }
} as const

// A machine without invocations, drained by the sender without a worker fiber.
const makeEditorMachine = () =>
  Machine.make({
    root: Machine.state({ states: { Editing, Saved } }),
    events: Machine.eventsFromSchemas(Changed, Pasted, Save),
    internalEvents: Machine.internalEventsFromSchemas(Normalized),
    emittedEvents: Emissions
  }).handle({
    initial: { target: "Editing", decoded: true, data: new Editing({ value: "" }) },
    states: {
      Editing: {
        on: {
          ...editing.on,
          Save: { target: "Saved", decoded: true, data: ({ state }) => new Saved({ value: state.value }) }
        }
      },
      Saved: {}
    }
  })

// A machine with an invocation, drained by a worker that starts in the
// sender's turn.
const makeFormMachine = (save: Effect.Effect<void>) =>
  Machine.make({
    effects: { save },
    root: Machine.state({ states: { Editing, Saving, Saved } }),
    events: Machine.eventsFromSchemas(Changed, Pasted, Save),
    internalEvents: Machine.internalEventsFromSchemas(Normalized),
    emittedEvents: Emissions
  }).handle({
    initial: { target: "Editing", decoded: true, data: new Editing({ value: "" }) },
    states: {
      Editing: {
        on: {
          ...editing.on,
          Save: { target: "Saving", decoded: true, data: ({ state }) => new Saving({ value: state.value }) }
        }
      },
      Saving: {
        invoke: {
          src: "save",
          id: "save",
          onDone: { target: "Saved", decoded: true, data: ({ state }) => new Saved({ value: state.value }) }
        }
      },
      Saved: {}
    }
  })

const leaf = (snapshot: Machine.RuntimeSnapshot<any, any, any>) => snapshot.state.state

const starts = [
  ["without invocations", () => Machine.start(makeEditorMachine())],
  ["with invocations", () => Machine.start(makeFormMachine(Effect.void))]
] as const

describe("synchronous delivery to an idle machine", () => {
  for (const [label, start] of starts) {
    describe(label, () => {
      it.effect("commits each transition before send returns", () =>
        Effect.gen(function*() {
          const ref = yield* start()
          const values: Array<unknown> = []
          for (
            const event of [new Changed({ value: "a" }), new Changed({ value: "ab" }), new Pasted({ value: " c " })]
          ) {
            Effect.runSync(ref.send(event))
            values.push(leaf(Effect.runSync(ref.snapshot)))
          }
          assert.deepStrictEqual(values, [
            { path: "Editing", value: new Editing({ value: "a" }) },
            { path: "Editing", value: new Editing({ value: "ab" }) },
            { path: "Editing", value: new Editing({ value: "c" }) }
          ])
          yield* ref.stop
        }))

      it.effect("publishes changes and emissions to subscribers in order after the sender yields", () =>
        Effect.gen(function*() {
          const ref = yield* start()
          const changes: Array<string> = []
          const emitted: Array<string> = []
          yield* ref.changes.pipe(
            Stream.runForEach((snapshot) => Effect.sync(() => changes.push(leaf(snapshot).value.value))),
            Effect.forkChild({ startImmediately: true })
          )
          yield* ref.emissions.pipe(
            Stream.runForEach((event) => Effect.sync(() => emitted.push((event as Published).value))),
            Effect.forkChild({ startImmediately: true })
          )
          yield* ref.send(new Changed({ value: "a" }))
          yield* ref.send(new Changed({ value: "ab" }))
          yield* ref.send(new Pasted({ value: "c" }))
          assert.deepStrictEqual(leaf(yield* ref.snapshot).value, new Editing({ value: "c" }))
          yield* Effect.yieldNow
          assert.deepStrictEqual(changes, ["", "a", "ab", "c"])
          assert.deepStrictEqual(emitted, ["c"])
          yield* ref.stop
        }))

      it.effect("settles events sent and stops requested by change observers", () =>
        Effect.gen(function*() {
          const ref = yield* start()
          yield* ref.changes.pipe(
            Stream.runForEach((snapshot) => {
              const value = leaf(snapshot).value.value
              return value === "a"
                ? ref.send(new Changed({ value: "ab" }))
                : value === "ab"
                ? ref.stop
                : Effect.void
            }),
            Effect.forkChild({ startImmediately: true })
          )
          yield* ref.send(new Changed({ value: "a" }))
          yield* Effect.exit(ref.join)
          const snapshot = yield* ref.snapshot
          assert.strictEqual(snapshot.status, "stopped")
          assert.deepStrictEqual(leaf(snapshot), { path: "Editing", value: new Editing({ value: "ab" }) })
        }))

      it.effect("completes an observed emission stream when an idle machine stops", () =>
        Effect.gen(function*() {
          const ref = yield* start()
          const emitted = yield* ref.emissions.pipe(
            Stream.runCollect,
            Effect.map(Array.from),
            Effect.forkChild({ startImmediately: true })
          )
          Effect.runSync(ref.send(new Pasted({ value: "a" })))
          Effect.runSync(ref.send(new Changed({ value: "ab" })))
          yield* ref.stop
          assert.deepStrictEqual(
            ((yield* Fiber.join(emitted)) as Array<Published>).map(({ value }) => value),
            ["a"]
          )
          assert.deepStrictEqual(Array.from(yield* Stream.runCollect(ref.emissions)), [])
        }))
    })
  }

  it.effect("commits the transition before send returns and continues suspended work in the background", () =>
    Effect.gen(function*() {
      const release = yield* Deferred.make<void>()
      const ref = yield* Machine.start(makeFormMachine(Deferred.await(release)))
      Effect.runSync(ref.send(new Changed({ value: "a" })))
      Effect.runSync(ref.send(new Save({})))
      assert.deepStrictEqual(leaf(Effect.runSync(ref.snapshot)), {
        path: "Saving",
        value: new Saving({ value: "a" })
      })
      const saved = yield* ref.changes.pipe(
        Stream.filter((snapshot) => leaf(snapshot).path === "Saved"),
        Stream.runHead,
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.succeed(release, undefined)
      const snapshot = yield* Fiber.join(saved)
      assert.deepStrictEqual(snapshot._tag === "Some" ? leaf(snapshot.value) : undefined, {
        path: "Saved",
        value: new Saved({ value: "a" })
      })
      yield* ref.stop
    }))
})
