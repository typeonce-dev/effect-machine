import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Option, Schema, Stream } from "effect"
import { Machine } from "../../src/index.js"
const waitForPath = <
  State extends Machine.Machine.CompoundSnapshot<string, unknown, Machine.Machine.AtomicSnapshot<string, unknown>>,
  Event,
  Error,
  Output
>(ref: Machine.MachineRef<State, Event, Error, Output>, path: State["state"]["path"]) =>
  ref.changes.pipe(
    Stream.filter((snapshot) => snapshot.status === "active" && snapshot.state.state.path === path),
    Stream.take(1),
    Stream.runDrain
  )
describe("dynamic child machines", () => {
  it.effect("spawns input-bearing children that survive owner state changes", () =>
    Effect.gen(function*() {
      class PlantActive extends Schema.TaggedClass<PlantActive>("DynamicPlantActive")("PlantActive", {
        id: Schema.String,
        produced: Schema.Number
      }) {
      }
      class Produce extends Schema.TaggedClass<Produce>("DynamicPlantProduce")("Produce", {
        amount: Schema.Number
      }) {
      }
      class Report extends Schema.TaggedClass<Report>("DynamicPlantReport")("Report", {}) {
      }
      class PlantReported extends Schema.TaggedClass<PlantReported>("DynamicPlantReported")("PlantReported", {
        id: Schema.String,
        produced: Schema.Number
      }) {
      }
      const PlantInput = Schema.Struct({ id: Schema.String, production: Schema.Number })
      const PlantOwnerEvents = Machine.eventsFromSchemas(PlantReported)
      const plantStates = Machine.state({
        fields: {
          input: Schema.toType(PlantInput)
        },
        states: { PlantActive }
      })
      const targets1 = Machine.targets(plantStates)
      const plantMachine = Machine.make({
        root: plantStates,
        events: Machine.eventsFromSchemas(Produce, Report),
        input: PlantInput,
        parent: Machine.parent(PlantOwnerEvents)
      }).handle({
        initial: {
          target: Machine.targets(plantStates).root.PlantActive,
          decoded: true,
          data: ({ root: { input: input } }) => new PlantActive({ id: input.id, produced: input.production })
        },
        root: ({ input }) => ({ input }),
        states: {
          PlantActive: {
            on: {
              Produce: {
                target: targets1.root.PlantActive,
                decoded: true,
                data: ({ event, state }) => (new PlantActive({ ...state, produced: state.produced + event.amount }))
              },
              Report: {
                none: true,
                resolve: ({ parent, state }, enqueue) => {
                  enqueue.sendTo(parent, PlantOwnerEvents.PlantReported({ id: state.id, produced: state.produced }))
                }
              }
            }
          }
        }
      })
      const Plant = Machine.childFamily(plantMachine)
      class Commissioning extends Schema.TaggedClass<Commissioning>("DynamicParentCommissioning")("Commissioning", {
        plants: Schema.Array(PlantInput)
      }) {
      }
      class Operating extends Schema.TaggedClass<Operating>("DynamicParentOperating")("Operating", {
        reports: Schema.Number
      }) {
      }
      class Grow extends Schema.TaggedClass<Grow>("DynamicGrow")("Grow", {
        plants: Schema.Array(PlantInput)
      }) {
      }
      class Decommission extends Schema.TaggedClass<Decommission>("DynamicDecommission")("Decommission", {
        id: Schema.String
      }) {
      }
      const parentStates = Machine.state({
        fields: {
          input: Schema.toType(Schema.Array(PlantInput))
        },
        states: { Commissioning, Operating }
      })
      const targets2 = Machine.targets(parentStates)
      const parentMachine = Machine.make({
        effects: {
          source1: ({ children, state }: Machine.Machine.InvokeContext<
            {
              readonly "": typeof parentStates.node
            },
            readonly [
              typeof PlantReported,
              typeof Grow,
              typeof Decommission
            ],
            readonly [],
            "Commissioning",
            readonly [
              typeof PlantReported,
              typeof Grow,
              typeof Decommission
            ],
            readonly []
          >) => Effect.forEach(state.plants, (input) => children.spawn(Plant(input.id), { input }), { discard: true })
        },
        root: parentStates,
        events: Machine.eventsFromSchemas(PlantOwnerEvents, Grow, Decommission),
        input: Schema.Array(PlantInput)
      }).handle({
        initial: {
          target: Machine.targets(parentStates).root.Commissioning,
          decoded: true,
          data: ({ root: { input: input } }) => new Commissioning({ plants: input })
        },
        root: ({ input }) => ({ input }),
        states: {
          Commissioning: {
            invoke: {
              src: "source1",
              id: "commission-wave",
              input: (context) => context,
              onDone: { target: targets2.root.Operating, decoded: true, data: () => (new Operating({ reports: 0 })) },
              onFailure: { none: true }
            }
          },
          Operating: {
            on: {
              PlantReported: {
                target: targets2.root.Operating,
                decoded: true,
                data: ({ state }) => (new Operating({ reports: state.reports + 1 }))
              },
              Grow: {
                target: targets2.root.Commissioning,
                decoded: true,
                data: ({ event }) => (new Commissioning({ plants: event.plants }))
              },
              Decommission: {
                none: true,
                resolve: ({ event }, enqueue) => {
                  enqueue.stop(Plant(event.id))
                }
              }
            }
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
        Stream.filter((snapshot) => snapshot.status === "active" && snapshot.state.state.value.produced === 15),
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
      assert.deepStrictEqual((yield* firstAfterTransitions.value.state).state, {
        path: "PlantActive",
        value: new PlantActive({ id: "p-1", produced: 15 })
      })
      const reported = yield* parent.changes.pipe(
        Stream.filter((snapshot) =>
          snapshot.status === "active" && snapshot.state.state.path === "Operating" &&
          snapshot.state.state.value.reports === 1
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
      assert.deepStrictEqual((yield* replacement.value.state).state, {
        path: "PlantActive",
        value: new PlantActive({ id: "p-1", produced: 50 })
      })
      yield* parent.stop
      assert.strictEqual((yield* second.value.snapshot).status, "stopped")
    }))
  it.effect("rejects duplicate dynamic ids without replacing the active child", () =>
    Effect.gen(function*() {
      class ChildIdle extends Schema.TaggedClass<ChildIdle>("DynamicDuplicateChildIdle")("ChildIdle", {}) {
      }
      const InitialRoot1 = Machine.state({ states: { ChildIdle } })
      const childMachine = Machine.make({
        root: InitialRoot1,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: Machine.targets(InitialRoot1).root.ChildIdle,
          decoded: true,
          data: new ChildIdle({})
        },
        states: {
          ChildIdle: {}
        }
      })
      const Child = Machine.childFamily(childMachine)
      class Starting extends Schema.TaggedClass<Starting>("DynamicDuplicateStarting")("Starting", {}) {
      }
      class DuplicateRejected
        extends Schema.TaggedClass<DuplicateRejected>("DynamicDuplicateRejected")("DuplicateRejected", {})
      {
      }
      const root3 = Machine.state({ states: { Starting, DuplicateRejected } })
      const targets3 = Machine.targets(root3)
      const parentMachine = Machine.make({
        effects: {
          source1: ({ children }: Machine.Machine.InvokeContext<
            {
              readonly "": {
                readonly initial: "Starting"
                readonly states: {
                  readonly Starting: typeof Starting
                  readonly DuplicateRejected: typeof DuplicateRejected
                }
              } & {
                readonly "~effect/Machine/ExplicitInitial": true
              }
            },
            readonly [],
            readonly [],
            "Starting",
            readonly [],
            readonly []
          >) => children.spawn(Child("same")).pipe(Effect.andThen(children.spawn(Child("same"))))
        },
        root: root3,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: Machine.targets(root3).root.Starting,
          decoded: true,
          data: new Starting({})
        },
        states: {
          Starting: {
            invoke: {
              src: "source1",
              id: "spawn-duplicate",
              input: (context) => context,
              onDone: { none: true },
              onFailure: { target: targets3.root.DuplicateRejected }
            }
          },
          DuplicateRejected: {}
        }
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
      }) {
      }
      const Input = Schema.Struct({ id: Schema.String })
      const InitialRoot2 = Machine.state({
        fields: {
          input: Schema.toType(Input)
        },
        states: { WorkerIdle }
      })
      const workerMachine = Machine.make({
        root: InitialRoot2,
        events: Machine.eventsFromSchemas(),
        input: Input
      }).handle({
        initial: {
          target: Machine.targets(InitialRoot2).root.WorkerIdle,
          decoded: true,
          data: ({ root: { input: input } }) => new WorkerIdle({ id: input.id })
        },
        root: ({ input }) => ({ input }),
        states: {
          WorkerIdle: {}
        }
      })
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
      class Running extends Schema.TaggedClass<Running>("DynamicLogicRunning")("Running", {}) {
      }
      const root4 = Machine.state({ states: { Running } })
      const parentMachine = Machine.make({
        logic: { source1: supervisorLogic },
        root: root4,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: Machine.targets(root4).root.Running,
          decoded: true,
          data: new Running({})
        },
        states: {
          Running: {
            invoke: { src: "source1", id: "supervisor", address: Supervisor }
          }
        }
      })
      const parent = yield* Machine.start(parentMachine)
      assert(scoped !== undefined)
      assert(second !== undefined)
      assert.deepStrictEqual((yield* scoped.state).state, {
        path: "WorkerIdle",
        value: new WorkerIdle({ id: "scoped" })
      })
      assert.deepStrictEqual((yield* second.state).state, {
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
      }) {
      }
      class Increment extends Schema.TaggedClass<Increment>("DynamicControlIncrement")("Increment", {}) {
      }
      const root5 = Machine.state({ states: { UnitActive } })
      const targets5 = Machine.targets(root5)
      const unitMachine = Machine.make({
        root: root5,
        events: Machine.eventsFromSchemas(Increment)
      }).handle({
        initial: {
          target: Machine.targets(root5).root.UnitActive,
          decoded: true,
          data: new UnitActive({ count: 0 })
        },
        states: {
          UnitActive: {
            on: {
              Increment: {
                target: targets5.root.UnitActive,
                decoded: true,
                data: ({ state }) => (new UnitActive({ count: state.count + 1 }))
              }
            }
          }
        }
      })
      const Unit = Machine.childFamily(unitMachine)
      class Managing extends Schema.TaggedClass<Managing>("DynamicControlManaging")("Managing", {}) {
      }
      class Ready extends Schema.TaggedClass<Ready>("DynamicControlReady")("Ready", {}) {
      }
      const root6 = Machine.state({ states: { Managing, Ready } })
      const targets6 = Machine.targets(root6)
      const parentMachine = Machine.make({
        effects: {
          source1: ({ children }: Machine.Machine.InvokeContext<
            {
              readonly "": {
                readonly initial: "Managing"
                readonly states: {
                  readonly Managing: typeof Managing
                  readonly Ready: typeof Ready
                }
              } & {
                readonly "~effect/Machine/ExplicitInitial": true
              }
            },
            readonly [],
            readonly [],
            "Managing",
            readonly [],
            readonly []
          >) =>
            Effect.gen(function*() {
              yield* children.spawn(Unit("kept"))
              yield* children.spawn(Unit("stopped"))
              yield* children.sendTo(Unit("kept"), new Increment({}))
              yield* children.stop(Unit("stopped"))
            })
        },
        root: root6,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: Machine.targets(root6).root.Managing,
          decoded: true,
          data: new Managing({})
        },
        states: {
          Managing: {
            invoke: {
              src: "source1",
              id: "control-units",
              input: (context) => context,
              onDone: { target: targets6.root.Ready },
              onFailure: { none: true }
            }
          },
          Ready: {}
        }
      })
      const parent = yield* Machine.start(parentMachine)
      yield* waitForPath(parent, "Ready").pipe(Effect.timeout("1 second"))
      const kept = yield* parent.child(Unit("kept"))
      assert(Option.isSome(kept))
      yield* kept.value.changes.pipe(
        Stream.filter((snapshot) => snapshot.status === "active" && snapshot.state.state.value.count === 1),
        Stream.take(1),
        Stream.runDrain,
        Effect.timeout("1 second")
      )
      assert(Option.isNone(yield* parent.child(Unit("stopped"))))
      yield* parent.stop
    }))
})
