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
  boundary: "Machine.defineStates" | "Machine.make",
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

const makeFromUnknownStates = (states: unknown): unknown =>
  Machine.make({
    states: states as Machine.Machine.StateSchemas,
    events: [],
    initial: (): never => {
      throw new Error("unreachable")
    }
  })

describe("exact state-definition runtime validation", () => {
  it("recognizes Effect schemas before inspecting config properties", () => {
    const AnnotatedIdle = Idle.annotate({
      title: "Idle",
      arbitrarySchemaAnnotation: { owner: "machine-team" }
    })
    const states = Machine.defineStates({ Idle: AnnotatedIdle })
    const machine = Machine.make({
      states: states.states,
      events: [],
      initial: () => states.initial.Idle(new Idle({}))
    })

    assert.strictEqual(Machine.stateNodes(machine)[0]?.path, "Idle")

    const prototypeNamed = Machine.defineStates({ constructor: Idle, toString: Done })
    assert.deepStrictEqual(prototypeNamed.initial.constructor(new Idle({})), {
      path: "constructor",
      value: new Idle({})
    })
  })

  it("accepts an opaque declaration whose Type satisfies TaggedSchema", () => {
    const states = Machine.defineStates({ Opaque: OpaqueState })
    const machine = Machine.make({
      states: states.states,
      events: [],
      initial: () => states.initial.Opaque({ _tag: "OpaqueState", value: 1 })
    })

    assert.strictEqual(Machine.stateNodes(machine)[0]?.path, "Opaque")
  })

  it("rejects schemas whose decoded type does not have a required PropertyKey _tag", () => {
    const UntaggedStruct = Schema.Struct({ value: Schema.String })

    for (const schema of [Schema.String, UntaggedStruct]) {
      for (const [node, path] of [[schema, "Invalid"], [{ schema }, "Invalid.schema"]] as const) {
        expectDefinitionError(
          () => Machine.defineStates({ Invalid: node } as unknown as Machine.Machine.StateSchemas),
          "Machine.defineStates",
          path,
          "required PropertyKey _tag"
        )
        expectDefinitionError(
          () => makeFromUnknownStates({ Invalid: node }),
          "Machine.make",
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
        () => Machine.defineStates(states as Machine.Machine.StateSchemas),
        "Machine.defineStates",
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
      "Machine.make",
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
        () => Machine.defineStates(states as Machine.Machine.StateSchemas),
        "Machine.defineStates",
        path,
        detail
      )
    }

    expectDefinitionError(
      () => makeFromUnknownStates({ 12: Idle }),
      "Machine.make",
      "12",
      "numeric forms"
    )
  })

  it("rejects unknown or non-string pseudo-state annotations", () => {
    expectDefinitionError(
      () =>
        Machine.defineStates({
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
        }),
      "Machine.defineStates",
      "Root.Choice.annotations",
      "executable"
    )
    expectDefinitionError(
      () =>
        Machine.defineStates({
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
        }),
      "Machine.defineStates",
      "Root.History.annotations.title",
      "must be strings"
    )
  })
})
