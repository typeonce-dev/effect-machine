import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Option, Schema, Stream } from "effect"
import { Machine } from "../../src/index.js"

const waitForPath = <State extends Machine.Machine.AtomicSnapshot<string, unknown>, Event, Error, Output>(
  ref: Machine.MachineRef<State, Event, Error, Output>,
  path: State["path"]
) =>
  ref.changes.pipe(
    Stream.filter((snapshot) => snapshot.status === "active" && snapshot.state.path === path),
    Stream.take(1),
    Stream.runDrain
  )

describe("dynamic child machines", () => {
  it.effect("spawns input-bearing children that survive owner state changes", () =>
    Effect.gen(function*() {
      class PlantActive extends Schema.TaggedClass<PlantActive>("DynamicPlantActive")("PlantActive", {
        id: Schema.String,
        produced: Schema.Number
      }) {}
      class Produce extends Schema.TaggedClass<Produce>("DynamicPlantProduce")("Produce", {
        amount: Schema.Number
      }) {}
      class Report extends Schema.TaggedClass<Report>("DynamicPlantReport")("Report", {}) {}
      class PlantReported extends Schema.TaggedClass<PlantReported>("DynamicPlantReported")("PlantReported", {
        id: Schema.String,
        produced: Schema.Number
      }) {}
      const PlantInput = Schema.Struct({ id: Schema.String, production: Schema.Number })
      const PlantOwnerEvents = Machine.events(PlantReported)
      const plantStates = Machine.states({ PlantActive })
      const plantMachine = Machine.make({
        states: plantStates.states,
        events: Machine.events(Produce, Report),
        input: PlantInput,
        parent: Machine.parent(PlantOwnerEvents),
        initial: (to) =>
          to.PlantActive().resolve(({ input, target }) =>
            target(new PlantActive({ id: input.id, produced: input.production }))
          )
      }).handle({
        PlantActive: {
          on: {
            Produce: (to) =>
              to.full.PlantActive().resolve(({ event, state, target }) =>
                target(new PlantActive({ ...state, produced: state.produced + event.amount }))
              ),
            Report: (to) =>
              to.none.resolve(({ parent, state }, enqueue) => {
                enqueue.sendTo(parent, PlantOwnerEvents.PlantReported({ id: state.id, produced: state.produced }))
              })
          }
        }
      })
      const Plant = Machine.childFamily(plantMachine)

      class Commissioning extends Schema.TaggedClass<Commissioning>("DynamicParentCommissioning")(
        "Commissioning",
        { plants: Schema.Array(PlantInput) }
      ) {}
      class Operating extends Schema.TaggedClass<Operating>("DynamicParentOperating")("Operating", {
        reports: Schema.Number
      }) {}
      class Grow extends Schema.TaggedClass<Grow>("DynamicGrow")("Grow", {
        plants: Schema.Array(PlantInput)
      }) {}
      class Decommission extends Schema.TaggedClass<Decommission>("DynamicDecommission")("Decommission", {
        id: Schema.String
      }) {}
      const parentStates = Machine.states({ Commissioning, Operating })
      const parentMachine = Machine.make({
        states: parentStates.states,
        events: Machine.events(PlantOwnerEvents, Grow, Decommission),
        input: Schema.Array(PlantInput),
        initial: (to) => to.Commissioning().resolve(({ input, target }) => target(new Commissioning({ plants: input })))
      }).handle({
        Commissioning: {
          invoke: (from) =>
            from.effect("commission-wave", ({ children, state }) =>
              Effect.forEach(
                state.plants,
                (input) => children.spawn(Plant(input.id), { input }),
                { discard: true }
              )).onDone((to) => to.full.Operating().resolve(({ target }) => target(new Operating({ reports: 0 }))))
              .onFailure((to) => to.none)
        },
        Operating: {
          on: {
            PlantReported: (to) =>
              to.full.Operating().resolve(({ state, target }) => target(new Operating({ reports: state.reports + 1 }))),
            Grow: (to) =>
              to.full.Commissioning().resolve(({ event, target }) =>
                target(new Commissioning({ plants: event.plants }))
              ),
            Decommission: (to) =>
              to.none.resolve(({ event }, enqueue) => {
                enqueue.stop(Plant(event.id))
              })
          }
        }
      })

      const parent = yield* Machine.start(parentMachine, [
        { id: "p-1", production: 10 },
        { id: "p-2", production: 20 }
      ])
      yield* waitForPath(parent, "Operating").pipe(Effect.timeout("1 second"))

      const first = yield* parent.child(Plant("p-1"))
      const second = yield* parent.child(Plant("p-2"))
      assert(Option.isSome(first))
      assert(Option.isSome(second))
      const reconstructedFirst = yield* parent.child(Machine.child("p-1", plantMachine))
      assert(Option.isSome(reconstructedFirst))
      assert.strictEqual(reconstructedFirst.value, first.value)

      const produced = yield* first.value.changes.pipe(
        Stream.filter((snapshot) => snapshot.status === "active" && snapshot.state.value.produced === 15),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkChild
      )
      yield* first.value.send(new Produce({ amount: 5 }))
      yield* Fiber.join(produced)

      const thirdStarted = yield* parent.childChanges(Plant("p-3")).pipe(
        Stream.filter(Option.isSome),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkChild
      )
      yield* parent.send(
        new Grow({
          plants: [
            { id: "p-3", production: 30 },
            { id: "p-4", production: 40 }
          ]
        })
      )
      yield* Fiber.join(thirdStarted)
      yield* waitForPath(parent, "Operating").pipe(Effect.timeout("1 second"))

      const firstAfterTransitions = yield* parent.child(Plant("p-1"))
      assert(Option.isSome(firstAfterTransitions))
      assert.strictEqual(firstAfterTransitions.value, first.value)
      assert(Option.isSome(yield* parent.child(Plant("p-3"))))
      assert.deepStrictEqual(yield* firstAfterTransitions.value.state, {
        path: "PlantActive",
        value: new PlantActive({ id: "p-1", produced: 15 })
      })

      const reported = yield* parent.changes.pipe(
        Stream.filter((snapshot) =>
          snapshot.status === "active" && snapshot.state.path === "Operating" && snapshot.state.value.reports === 1
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkChild
      )
      yield* first.value.send(new Report({}))
      yield* Fiber.join(reported)

      const decommissioned = yield* parent.childChanges(Plant("p-1")).pipe(
        Stream.filter(Option.isNone),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkChild
      )
      yield* parent.send(new Decommission({ id: "p-1" }))
      yield* Fiber.join(decommissioned)
      assert(Option.isNone(yield* parent.child(Plant("p-1"))))
      assert(Option.isSome(yield* parent.child(Plant("p-2"))))

      const recommissioned = yield* parent.childChanges(Plant("p-1")).pipe(
        Stream.filter(Option.isSome),
        Stream.take(1),
        Stream.runCollect,
        Effect.map((values) => Array.from(values)[0]!),
        Effect.forkChild
      )
      yield* parent.send(new Grow({ plants: [{ id: "p-1", production: 50 }] }))
      const replacement = yield* Fiber.join(recommissioned)
      assert(Option.isSome(replacement))
      assert.notStrictEqual(replacement.value, first.value)
      assert.deepStrictEqual(yield* replacement.value.state, {
        path: "PlantActive",
        value: new PlantActive({ id: "p-1", produced: 50 })
      })

      yield* parent.stop
      assert.strictEqual((yield* second.value.snapshot).status, "stopped")
    }))

  it.effect("rejects duplicate dynamic ids without replacing the active child", () =>
    Effect.gen(function*() {
      class ChildIdle extends Schema.TaggedClass<ChildIdle>("DynamicDuplicateChildIdle")("ChildIdle", {}) {}
      const childMachine = Machine.make({
        states: { ChildIdle },
        events: Machine.events(),
        initial: (to) => to.ChildIdle().resolve(({ target }) => target(new ChildIdle({})))
      }).handle({ ChildIdle: {} })
      const Child = Machine.childFamily(childMachine)
      class Starting extends Schema.TaggedClass<Starting>("DynamicDuplicateStarting")("Starting", {}) {}
      class DuplicateRejected extends Schema.TaggedClass<DuplicateRejected>("DynamicDuplicateRejected")(
        "DuplicateRejected",
        {}
      ) {}
      const parentMachine = Machine.make({
        states: { Starting, DuplicateRejected },
        events: Machine.events(),
        initial: (to) => to.Starting().resolve(({ target }) => target(new Starting({})))
      }).handle({
        Starting: {
          invoke: (from) =>
            from.effect("spawn-duplicate", ({ children }) =>
              children.spawn(Child("same")).pipe(
                Effect.andThen(children.spawn(Child("same")))
              )).onDone((to) => to.none).onFailure((to) => to.full.DuplicateRejected())
        },
        DuplicateRejected: {}
      })

      const parent = yield* Machine.start(parentMachine)
      yield* waitForPath(parent, "DuplicateRejected").pipe(Effect.timeout("1 second"))

      assert(Option.isSome(yield* parent.child(Child("same"))))
      yield* parent.stop
    }))

  it.effect("spawns child machine descriptors from process logic", () =>
    Effect.gen(function*() {
      class WorkerIdle extends Schema.TaggedClass<WorkerIdle>("DynamicLogicWorkerIdle")("WorkerIdle", {
        id: Schema.String
      }) {}
      const Input = Schema.Struct({ id: Schema.String })
      const workerMachine = Machine.make({
        states: { WorkerIdle },
        events: Machine.events(),
        input: Input,
        initial: (to) => to.WorkerIdle().resolve(({ input, target }) => target(new WorkerIdle({ id: input.id })))
      }).handle({ WorkerIdle: {} })
      const Worker = Machine.childFamily(workerMachine)
      let scoped: Machine.ChildMachine.Ref<ReturnType<typeof Worker>> | undefined
      let second: Machine.ChildMachine.Ref<ReturnType<typeof Worker>> | undefined
      const supervisorLogic = Machine.logic({
        initial: ({ spawn }) =>
          Effect.all([
            spawn(Worker("scoped"), { input: { id: "scoped" } }),
            spawn(Worker("second"), { input: { id: "second" } })
          ]).pipe(
            Effect.tap(([scopedRef, secondRef]) =>
              Effect.sync(() => {
                scoped = scopedRef
                second = secondRef
              })
            ),
            Effect.as(undefined)
          ),
        run: () => Effect.never
      })
      const Supervisor = Machine.childAddress("supervisor")
      class Running extends Schema.TaggedClass<Running>("DynamicLogicRunning")("Running", {}) {}
      const parentMachine = Machine.make({
        states: { Running },
        events: Machine.events(),
        initial: (to) => to.Running().resolve(({ target }) => target(new Running({})))
      }).handle({
        Running: {
          invoke: (from) => from.logic("supervisor", { address: Supervisor, logic: supervisorLogic })
        }
      })

      const parent = yield* Machine.start(parentMachine)
      assert(scoped !== undefined)
      assert(second !== undefined)
      assert.deepStrictEqual(yield* scoped.state, {
        path: "WorkerIdle",
        value: new WorkerIdle({ id: "scoped" })
      })
      assert.deepStrictEqual(yield* second.state, {
        path: "WorkerIdle",
        value: new WorkerIdle({ id: "second" })
      })

      yield* parent.stop
      assert.strictEqual((yield* scoped.snapshot).status, "stopped")
      assert.strictEqual((yield* second.snapshot).status, "stopped")
    }))

  it.effect("sends to and stops process-owned children from an invoked Effect", () =>
    Effect.gen(function*() {
      class UnitActive extends Schema.TaggedClass<UnitActive>("DynamicControlUnitActive")("UnitActive", {
        count: Schema.Number
      }) {}
      class Increment extends Schema.TaggedClass<Increment>("DynamicControlIncrement")("Increment", {}) {}
      const unitMachine = Machine.make({
        states: { UnitActive },
        events: Machine.events(Increment),
        initial: (to) => to.UnitActive().resolve(({ target }) => target(new UnitActive({ count: 0 })))
      }).handle({
        UnitActive: {
          on: {
            Increment: (to) =>
              to.full.UnitActive().resolve(({ state, target }) => target(new UnitActive({ count: state.count + 1 })))
          }
        }
      })
      const Unit = Machine.childFamily(unitMachine)
      class Managing extends Schema.TaggedClass<Managing>("DynamicControlManaging")("Managing", {}) {}
      class Ready extends Schema.TaggedClass<Ready>("DynamicControlReady")("Ready", {}) {}
      const parentMachine = Machine.make({
        states: { Managing, Ready },
        events: Machine.events(),
        initial: (to) => to.Managing().resolve(({ target }) => target(new Managing({})))
      }).handle({
        Managing: {
          invoke: (from) =>
            from.effect("control-units", ({ children }) =>
              Effect.gen(function*() {
                yield* children.spawn(Unit("kept"))
                yield* children.spawn(Unit("stopped"))
                yield* children.sendTo(Unit("kept"), new Increment({}))
                yield* children.stop(Unit("stopped"))
              })).onDone((to) => to.full.Ready()).onFailure((to) => to.none)
        },
        Ready: {}
      })

      const parent = yield* Machine.start(parentMachine)
      yield* waitForPath(parent, "Ready").pipe(Effect.timeout("1 second"))
      const kept = yield* parent.child(Unit("kept"))
      assert(Option.isSome(kept))
      yield* kept.value.changes.pipe(
        Stream.filter((snapshot) => snapshot.status === "active" && snapshot.state.value.count === 1),
        Stream.take(1),
        Stream.runDrain,
        Effect.timeout("1 second")
      )
      assert(Option.isNone(yield* parent.child(Unit("stopped"))))
      yield* parent.stop
    }))
})
