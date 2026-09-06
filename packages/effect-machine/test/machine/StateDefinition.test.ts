import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { Machine } from "../../src/index.js"

class Root extends Schema.TaggedClass<Root>("Root")("Root", {}) {}
class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
class Done extends Schema.TaggedClass<Done>("Done")("Done", {}) {}

interface OpaqueState {
  readonly _tag: "OpaqueState"
  readonly value: number
}

const OpaqueState = Schema.declare<OpaqueState>((input): input is OpaqueState =>
  typeof input === "object" && input !== null && "_tag" in input && input._tag === "OpaqueState" &&
  "value" in input && typeof input.value === "number"
)

const expectDefinitionError = (
  run: () => unknown,
  boundary: "Machine.state",
  path: string,
  detail: string
): void => {
  let failure: unknown
  try {
    run()
  } catch (error) {
    failure = error
  }
  assert.instanceOf(failure, Error)
  assert.include(failure.message, `${boundary} invalid state definition at "${path}"`)
  assert.include(failure.message, detail)
}

const unsafeState = Machine.state as (definition: unknown) => Machine.State<Machine.Machine.StateNodeConfig>

const makeFromUnknownStates = (states: unknown): unknown =>
  Machine.make({
    root: unsafeState({
      initial: typeof states === "object" && states !== null ? Object.keys(states)[0] ?? "Root" : "Root",
      states: states as Machine.Machine.StateSchemas
    }),
    events: Machine.eventsFromSchemas(),
    initialConfiguration: {} as any
  })

describe("exact state-definition runtime validation", () => {
  it("captures raw definitions before compiling topology and selectors", () => {
    const raw = { Root: { initial: "Idle" as const, states: { Idle: {}, Done: {} } } }
    const machine = Machine.make({
      root: Machine.state({ initial: "Root", states: raw }),
      events: Machine.eventsFromSchemas(),
      initialConfiguration: (root) =>
        root.resolve(({ target }) => target.from((to) => to.Root.from((child) => child.Idle.from())))
    })
    Object.assign(raw.Root, { initial: "Done" })
    Object.assign(raw.Root.states, { Added: {} })
    assert.notStrictEqual(machine.root.node.states, raw)
    assert.strictEqual(machine.root.node.states.Root.initial, "Idle")
    assert.deepStrictEqual(Object.keys(machine.root.node.states.Root.states), ["Idle", "Done"])
    assert.isTrue(Object.isFrozen(machine.root.node.states.Root.states))
    assert.throws(() => machine.handle({ states: { Root: { states: { Added: {} } } } as never }), /unknown state/)
  })

  it("captures reusable state definitions independently at each mount", () => {
    const TradingSlot = Machine.state({
      initial: "Idle",
      states: {
        Idle: {},
        InSession: Idle,
        Applying: Done
      }
    })
    const states = Machine.state({
      initial: "trading",
      states: {
        trading: {
          type: "parallel",
          states: {
            slot1: TradingSlot,
            slot2: TradingSlot
          }
        }
      }
    })

    assert.notStrictEqual(states.node.states.trading.states.slot1, TradingSlot.node)
    assert.notStrictEqual(states.node.states.trading.states.slot1, states.node.states.trading.states.slot2)
    assert.deepStrictEqual(states.node.states.trading.states.slot1, TradingSlot.node)
    assert.isTrue(Object.isFrozen(TradingSlot))
    assert.isTrue(Object.isFrozen(states.node.states.trading.states.slot1))
    assert.strictEqual(states.node.states.trading.states.slot1.states.InSession, Idle)
    assert.strictEqual(states.path("trading.slot2.InSession"), "trading.slot2.InSession")
  })

  it("reports reusable state errors at the Machine.state boundary", () => {
    expectDefinitionError(
      () =>
        Machine.state({
          initial: "Missing",
          states: { Idle: {} }
        } as never),
      "Machine.state",
      ".initial",
      "does not exist"
    )
  })

  it("accepts schema-less active states without confusing them with pseudo-states", () => {
    const states = Machine.state({
      initial: "Idle",
      states: {
        Idle: {
          annotations: { title: "Idle", description: "No state-local data" }
        },
        Flow: {
          initial: "Waiting",
          states: {
            Waiting: {},
            Done: { type: "final", output: Schema.String }
          }
        },
        Regions: {
          type: "parallel",
          states: {
            left: {},
            right: {}
          }
        }
      }
    })
    const machine = Machine.make({
      root: states,
      events: Machine.eventsFromSchemas(),
      initialConfiguration: (root) => root.resolve(({ target }) => target.from((to) => to.Idle.from()))
    })

    const nodes = Machine.stateNodes(machine)
    assert.strictEqual(nodes.find(({ path }) => path === "Idle")?.schema, undefined)
    assert.deepStrictEqual(nodes.find(({ path }) => path === "Idle")?.annotations, {
      title: "Idle",
      description: "No state-local data"
    })
    assert.strictEqual(nodes.find(({ path }) => path === "Flow")?.type, "compound")
    assert.strictEqual(nodes.find(({ path }) => path === "Flow.Done")?.type, "final")
    assert.strictEqual(nodes.find(({ path }) => path === "Regions")?.type, "parallel")
  })

  it("recognizes Effect schemas before inspecting config properties", () => {
    const AnnotatedIdle = Idle.annotate({
      title: "Idle",
      arbitrarySchemaAnnotation: { owner: "machine-team" }
    })
    const states = Machine.state({ initial: "Idle", states: { Idle: AnnotatedIdle } })
    const machine = Machine.make({
      root: states,
      events: Machine.eventsFromSchemas(),
      initialConfiguration: (root) => root.resolve(({ target }) => target.from((to) => to.Idle.decoded(new Idle({}))))
    })

    assert.strictEqual(Machine.stateNodes(machine)[1]?.path, "Idle")

    const prototypeNamed = Machine.state({ initial: "constructor", states: { constructor: Idle, toString: Done } })
    assert.strictEqual(prototypeNamed.node.states.constructor, Idle)
    assert.strictEqual(prototypeNamed.node.states.toString, Done)
  })

  it("accepts an opaque declaration whose Type satisfies TaggedSchema", () => {
    const states = Machine.state({ initial: "Opaque", states: { Opaque: OpaqueState } })
    const machine = Machine.make({
      root: states,
      events: Machine.eventsFromSchemas(),
      initialConfiguration: (root) =>
        root.resolve(({ target }) => target.from((to) => to.Opaque.decoded({ _tag: "OpaqueState", value: 1 })))
    })

    assert.strictEqual(Machine.stateNodes(machine)[1]?.path, "Opaque")
  })

  it("rejects schemas whose decoded type does not have a required PropertyKey _tag", () => {
    const UntaggedStruct = Schema.Struct({ value: Schema.String })

    for (const schema of [Schema.String, UntaggedStruct]) {
      for (const [node, path] of [[schema, "Invalid"], [{ schema }, "Invalid.schema"]] as const) {
        expectDefinitionError(
          () =>
            unsafeState({ initial: "Invalid", states: { Invalid: node } as unknown as Machine.Machine.StateSchemas }),
          "Machine.state",
          path,
          "required PropertyKey _tag"
        )
        expectDefinitionError(
          () => makeFromUnknownStates({ Invalid: node }),
          "Machine.state",
          path,
          "required PropertyKey _tag"
        )
      }
    }
  })

  it("rejects unknown properties for every state kind with the complete nested path", () => {
    const invalidTrees: ReadonlyArray<readonly [unknown, string, string]> = [
      [{ Idle: { schema: Idle, unknown: true } }, "Idle", "atomic states"],
      [{ Done: { schema: Done, type: "final", unknown: true } }, "Done", "final states"],
      [{ Root: { schema: Root, initial: "Idle", states: { Idle }, unknown: true } }, "Root", "compound states"],
      [{ Root: { schema: Root, type: "parallel", states: { Idle }, unknown: true } }, "Root", "parallel states"],
      [
        {
          Root: {
            schema: Root,
            initial: "Idle",
            states: { Idle, History: { type: "history", unknown: true } }
          }
        },
        "Root.History",
        "history states"
      ],
      [
        {
          Root: {
            schema: Root,
            initial: "Idle",
            states: { Idle, Choice: { type: "choice", unknown: true } }
          }
        },
        "Root.Choice",
        "choice states"
      ]
    ]

    for (const [states, path, detail] of invalidTrees) {
      expectDefinitionError(
        () =>
          unsafeState({
            initial: typeof states === "object" && states !== null ? Object.keys(states)[0] ?? "Root" : "Root",
            states: states as Machine.Machine.StateSchemas
          }),
        "Machine.state",
        path,
        detail
      )
    }

    expectDefinitionError(
      () =>
        makeFromUnknownStates({
          Root: {
            schema: Root,
            initial: "Idle",
            states: { Idle: { schema: Idle, nestedUnknown: true } }
          }
        }),
      "Machine.state",
      "Root.Idle",
      "nestedUnknown"
    )
  })

  it("rejects invalid state keys recursively, including symbol and __proto__ keys", () => {
    const symbolKey = Symbol("state")
    const symbolTree = { Idle } as Record<PropertyKey, unknown>
    symbolTree[symbolKey] = Idle

    const protoTree = Object.create(null) as Record<PropertyKey, unknown>
    Object.defineProperty(protoTree, "__proto__", { enumerable: true, value: Idle })
    const implicitProtoTree = { __proto__: { injected: Idle }, Idle }

    const invalidTrees: ReadonlyArray<readonly [unknown, string, string]> = [
      [{ "": Idle }, "<empty>", "cannot be empty"],
      [{ "bad.path": Idle }, "bad.path", "cannot contain"],
      [{ 0: Idle }, "0", "numeric forms"],
      [{ "01": Idle }, "01", "numeric forms"],
      [{ "-1": Idle }, "-1", "numeric forms"],
      [{ "1e3": Idle }, "1e3", "numeric forms"],
      [{ "0x10": Idle }, "0x10", "numeric forms"],
      [{ " 1": Idle }, " 1", "numeric forms"],
      [{ "1 ": Idle }, "1 ", "numeric forms"],
      [{ " ": Idle }, " ", "numeric forms"],
      [{ "\t": Idle }, "\t", "numeric forms"],
      [symbolTree, "[Symbol(state)]", "not symbols"],
      [protoTree, "__proto__", "not allowed"],
      [implicitProtoTree, "__proto__", "implicit"],
      [
        {
          Root: {
            schema: Root,
            initial: "bad.path",
            states: { "bad.path": Idle }
          }
        },
        "Root.bad.path",
        "cannot contain"
      ]
    ]

    for (const [states, path, detail] of invalidTrees) {
      expectDefinitionError(
        () =>
          unsafeState({
            initial: typeof states === "object" && states !== null ? Object.keys(states)[0] ?? "Root" : "Root",
            states: states as Machine.Machine.StateSchemas
          }),
        "Machine.state",
        path,
        detail
      )
    }

    expectDefinitionError(
      () => makeFromUnknownStates({ 12: Idle }),
      "Machine.state",
      "12",
      "numeric forms"
    )
  })

  it("rejects child keys reserved by definition-time target selectors", () => {
    expectDefinitionError(
      () =>
        unsafeState({
          initial: "Root",
          states: {
            Root: {
              initial: "initial",
              states: { initial: Idle }
            }
          } as any
        }),
      "Machine.state",
      "Root.initial",
      "reserved target selector key"
    )
    expectDefinitionError(
      () =>
        unsafeState({
          initial: "Root",
          states: {
            Root: {
              schema: Root,
              initial: "with",
              states: { with: Idle }
            }
          } as any
        }),
      "Machine.state",
      "Root.with",
      "reserved local target selector key"
    )
  })

  it("rejects unknown or non-string pseudo-state annotations", () => {
    expectDefinitionError(
      () =>
        Machine.state({
          initial: "Root",
          states: {
            Root: {
              schema: Root,
              initial: "Idle",
              states: {
                Idle,
                Choice: {
                  type: "choice",
                  annotations: { executable: true }
                } as never
              }
            }
          }
        }),
      "Machine.state",
      "Root.Choice.annotations",
      "executable"
    )
    expectDefinitionError(
      () =>
        Machine.state({
          initial: "Root",
          states: {
            Root: {
              schema: Root,
              initial: "Idle",
              states: {
                Idle,
                History: {
                  type: "history",
                  annotations: { title: 1 }
                } as never
              }
            }
          }
        }),
      "Machine.state",
      "Root.History.annotations.title",
      "must be strings"
    )
  })

  it("rejects malformed schema-less active states at the runtime boundary", () => {
    const invalidTrees: ReadonlyArray<readonly [unknown, string, string]> = [
      [{ Invalid: { schema: undefined } }, "Invalid.schema", "required PropertyKey _tag"],
      [{ Invalid: { states: { Child: {} } } }, "Invalid.initial", "must declare an initial child"],
      [{ Invalid: { type: "parallel" } }, "Invalid.states", "must declare child regions"],
      [
        { Invalid: { annotations: { executable: "no" } } },
        "Invalid.annotations",
        "cannot declare property"
      ],
      [
        { Invalid: { annotations: { title: 1 } } },
        "Invalid.annotations.title",
        "must be strings"
      ]
    ]

    for (const [states, path, detail] of invalidTrees) {
      expectDefinitionError(
        () =>
          unsafeState({
            initial: typeof states === "object" && states !== null ? Object.keys(states)[0] ?? "Root" : "Root",
            states: states as Machine.Machine.StateSchemas
          }),
        "Machine.state",
        path,
        detail
      )
    }
  })
})
