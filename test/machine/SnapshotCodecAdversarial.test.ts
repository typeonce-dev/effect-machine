import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Option, Schema } from "effect"
import { FastCheck } from "effect/testing"
import { Machine } from "../../src/index.js"

class Root extends Schema.TaggedClass<Root>("CodecRoot")("CodecRoot", {
  id: Schema.NonEmptyString
}) {}
class Left extends Schema.TaggedClass<Left>("CodecLeft")("CodecLeft", {}) {}
class LeftWorking extends Schema.TaggedClass<LeftWorking>("CodecLeftWorking")("CodecLeftWorking", {
  task: Schema.NonEmptyString
}) {}
class LeftDone extends Schema.TaggedClass<LeftDone>("CodecLeftDone")("CodecLeftDone", {}) {}
class Right extends Schema.TaggedClass<Right>("CodecRight")("CodecRight", {}) {}
class RightWorking extends Schema.TaggedClass<RightWorking>("CodecRightWorking")("CodecRightWorking", {
  enabled: Schema.Boolean
}) {}
class RightDone extends Schema.TaggedClass<RightDone>("CodecRightDone")("CodecRightDone", {}) {}

const TopologyStates = Machine.states({
  Root: {
    schema: Root,
    type: "parallel",
    states: {
      left: {
        schema: Left,
        initial: "working",
        states: {
          working: LeftWorking,
          done: {
            schema: LeftDone,
            type: "final",
            output: Schema.NumberFromString
          }
        }
      },
      right: {
        schema: Right,
        initial: "working",
        states: {
          working: RightWorking,
          done: {
            schema: RightDone,
            type: "final",
            output: Schema.Boolean
          }
        }
      }
    }
  }
})

const topologyMachine = Machine.make({
  id: "codec-topology",
  states: TopologyStates.states,
  events: Machine.events(),
  initial: { target: (to) => to.Root.initial(), resolve: () => topologyActive() }
})

const topologyActive = () => ({
  path: "Root" as const,
  value: new Root({ id: "root-1" }),
  states: {
    left: {
      path: "Root.left" as const,
      value: new Left({}),
      state: { path: "Root.left.working" as const, value: new LeftWorking({ task: "left-1" }) }
    },
    right: {
      path: "Root.right" as const,
      value: new Right({}),
      state: { path: "Root.right.working" as const, value: new RightWorking({ enabled: true }) }
    }
  }
})

const topologyFinal = () =>
  ({
    path: "Root" as const,
    value: new Root({ id: "root-1" }),
    states: {
      left: {
        path: "Root.left" as const,
        value: new Left({}),
        state: { path: "Root.left.done" as const, value: new LeftDone({}) }
      },
      right: {
        path: "Root.right" as const,
        value: new Right({}),
        state: { path: "Root.right.done" as const, value: new RightDone({}) }
      }
    },
    completed: [
      { path: "Root.left.done" as const, output: 7 },
      { path: "Root.right.done" as const, output: true }
    ]
  }) as Machine.Machine.Snapshot<typeof TopologyStates.states>

class Workspace extends Schema.TaggedClass<Workspace>("CodecWorkspace")("CodecWorkspace", {
  revision: Schema.Number
}) {}
class Editor extends Schema.TaggedClass<Editor>("CodecEditor")("CodecEditor", {
  document: Schema.NonEmptyString
}) {}
class Editing extends Schema.TaggedClass<Editing>("CodecEditing")("CodecEditing", {
  contents: Schema.String
}) {}
class Preview extends Schema.TaggedClass<Preview>("CodecPreview")("CodecPreview", {
  page: Schema.Number
}) {}
class Outside extends Schema.TaggedClass<Outside>("CodecOutside")("CodecOutside", {}) {}

const HistoryStates = Machine.states({
  Workspace: {
    schema: Workspace,
    initial: "Editor",
    states: {
      Editor: {
        schema: Editor,
        initial: "editing",
        states: {
          editing: Editing,
          preview: Preview
        }
      },
      recent: { type: "history" },
      exact: { type: "history", history: "deep" }
    }
  },
  Outside
})

const historyMachine = Machine.make({
  id: "codec-history",
  states: HistoryStates.states,
  events: Machine.events(),
  initial: {
    target: (to) => to.Outside(),
    resolve: ({ target }) => target(new Outside({}))
  }
})

const historySnapshot = () =>
  ({
    ...{ path: "Outside" as const, value: new Outside({}) },
    history: {
      "Workspace.recent": {
        mode: "shallow" as const,
        active: ["Workspace", "Workspace.Editor"],
        values: {
          Workspace: new Workspace({ revision: 3 }),
          "Workspace.Editor": new Editor({ document: "doc-1" })
        }
      },
      "Workspace.exact": {
        mode: "deep" as const,
        active: ["Workspace", "Workspace.Editor", "Workspace.Editor.editing"],
        values: {
          Workspace: new Workspace({ revision: 3 }),
          "Workspace.Editor": new Editor({ document: "doc-1" }),
          "Workspace.Editor.editing": new Editing({ contents: "hello" })
        }
      }
    }
  }) as Machine.Machine.Snapshot<typeof HistoryStates.states>

const expectEncodeFailure = Effect.fnUntraced(function*(snapshot: unknown, boundary?: string) {
  const error = yield* Machine.encodeSnapshot(
    topologyMachine,
    snapshot as Machine.Machine.Snapshot<typeof TopologyStates.states>
  ).pipe(Effect.flip)
  assert.instanceOf(error, Machine.MachineSchemaEncodeError)
  if (boundary !== undefined) assert.strictEqual(error.boundary, boundary)
})

const expectDecodeFailure = Effect.fnUntraced(function*(
  decoding: Effect.Effect<unknown, Machine.MachineSchemaDecodeError>,
  boundary?: string
) {
  const error = yield* decoding.pipe(Effect.flip)
  assert.instanceOf(error, Machine.MachineSchemaDecodeError)
  if (boundary !== undefined) assert.strictEqual(error.boundary, boundary)
})

describe("snapshot codec adversarial boundaries", () => {
  it.effect.prop(
    "turns arbitrary JSON-shaped boundary input into values or typed failures, never defects",
    { input: FastCheck.jsonValue() },
    ({ input }) =>
      Effect.gen(function*() {
        const encodeExit = yield* Effect.exit(Machine.encodeSnapshot(topologyMachine, input as any))
        const decodeExit = yield* Effect.exit(Machine.decodeSnapshot(topologyMachine, input))
        const exits: ReadonlyArray<Exit.Exit<unknown, unknown>> = [encodeExit, decodeExit]

        for (const exit of exits) {
          if (Exit.isSuccess(exit)) continue
          assert.strictEqual(Cause.hasDies(exit.cause), false)
          const error = Cause.findErrorOption(exit.cause)
          assert(Option.isSome(error))
          assert.ok(
            error.value instanceof Machine.MachineSchemaEncodeError ||
              error.value instanceof Machine.MachineSchemaDecodeError
          )
        }
      }),
    { fastCheck: { numRuns: 100, seed: 83_117 } }
  )

  it.effect("round-trips active parallel and completed final configurations through JSON", () =>
    Effect.gen(function*() {
      for (const snapshot of [topologyActive(), topologyFinal()]) {
        const encoded = yield* Machine.encodeSnapshot(topologyMachine, snapshot)
        const decoded = yield* Machine.decodeSnapshot(topologyMachine, JSON.parse(JSON.stringify(encoded)))
        assert.deepStrictEqual(decoded, snapshot)
      }

      const encodedFinal = yield* Machine.encodeSnapshot(topologyMachine, topologyFinal())
      assert.deepStrictEqual(encodedFinal.completed, [
        { path: "Root.left.done" as const, output: "7" },
        { path: "Root.right.done" as const, output: true }
      ])
    }))

  it.effect("round-trips shallow and deep history records through JSON", () =>
    Effect.gen(function*() {
      const snapshot = historySnapshot()
      const encoded = yield* Machine.encodeSnapshot(historyMachine, snapshot)
      const decoded = yield* Machine.decodeSnapshot(historyMachine, JSON.parse(JSON.stringify(encoded)))

      assert.deepStrictEqual(decoded, snapshot)
      assert.instanceOf(decoded.history?.["Workspace.recent"]?.values.Workspace, Workspace)
      assert.instanceOf(decoded.history?.["Workspace.exact"]?.values["Workspace.Editor.editing"], Editing)
    }))

  it.effect("resumes a transported stable boundary without running a newly added automatic transition", () =>
    Effect.gen(function*() {
      class Before extends Schema.TaggedClass<Before>("CodecAutomaticBefore")("CodecAutomaticBefore", {}) {}
      class Boundary extends Schema.TaggedClass<Boundary>("CodecAutomaticBoundary")("CodecAutomaticBoundary", {}) {}
      class After extends Schema.TaggedClass<After>("CodecAutomaticAfter")("CodecAutomaticAfter", {}) {}
      const states = Machine.states({ Before, Boundary, After })
      const original = Machine.make({
        id: "codec-automatic-original",
        states: states.states,
        events: Machine.events(),
        initial: {
          target: (to) => to.Before(),
          resolve: ({ target }) => target(new Before({}))
        }
      }).handle({
        Before: {
          always: Machine.transition({
            target: (to) => to.full.Boundary(),
            resolve: ({ target }) => target(new Boundary({}))
          })
        },
        Boundary: {},
        After: {}
      })
      const changed = Machine.make({
        id: "codec-automatic-changed",
        states: states.states,
        events: Machine.events(),
        initial: {
          target: (to) => to.Before(),
          resolve: ({ target }) => target(new Before({}))
        }
      }).handle({
        Before: {},
        Boundary: {
          always: Machine.transition({
            target: (to) => to.full.After(),
            resolve: ({ target }) => target(new After({}))
          })
        },
        After: {}
      })

      const stable = (yield* Machine.planInitial(original)).state
      assert.strictEqual(stable.path, "Boundary")
      const transported = JSON.parse(JSON.stringify(yield* Machine.encodeSnapshot(original, stable)))
      const decoded = yield* Machine.decodeSnapshot(changed, transported)
      const resumed = yield* Machine.resume(changed, decoded)

      assert.strictEqual((yield* resumed.state).path, "Boundary")
      yield* Effect.yieldNow
      assert.strictEqual((yield* resumed.state).path, "Boundary")
      yield* resumed.stop
    }))

  it.effect("rejects malformed logical topology before encoding", () =>
    Effect.gen(function*() {
      const valid = topologyActive()
      const malformed: ReadonlyArray<unknown> = [
        { path: "Missing" as const, value: {} },
        { ...valid, states: { left: valid.states.left } },
        {
          ...valid,
          states: {
            ...valid.states,
            left: { ...valid.states.left, state: valid.states.right.state }
          }
        },
        {
          ...valid,
          states: {
            ...valid.states,
            left: { ...valid.states.left, value: { _tag: "CodecLeft" } },
            right: { ...valid.states.right, value: { _tag: "CodecRight", unexpected: true } }
          }
        }
      ]

      for (const snapshot of malformed) {
        yield* expectEncodeFailure(snapshot)
      }
    }))

  it.effect("rejects unknown, duplicate, missing, extra, and impossible encoded configurations", () =>
    Effect.gen(function*() {
      const encoded = yield* Machine.encodeSnapshot(topologyMachine, topologyActive())
      const mutations: Array<unknown> = []

      const unknown = structuredClone(encoded) as any
      unknown.active[2].path = "Root.left.missing"
      mutations.push(unknown)

      const duplicate = structuredClone(encoded) as any
      duplicate.active.push(structuredClone(duplicate.active[2]))
      mutations.push(duplicate)

      const missingRegion = structuredClone(encoded) as any
      missingRegion.active = missingRegion.active.filter((entry: any) => !entry.path.startsWith("Root.right"))
      mutations.push(missingRegion)

      const extraCompoundBranch = structuredClone(encoded) as any
      extraCompoundBranch.active.push({ path: "Root.left.done" as const, value: { _tag: "CodecLeftDone" } })
      mutations.push(extraCompoundBranch)

      const impossibleAncestry = structuredClone(encoded) as any
      impossibleAncestry.active = impossibleAncestry.active.filter((entry: any) => entry.path !== "Root.left")
      mutations.push(impossibleAncestry)

      for (const mutation of mutations) {
        yield* expectDecodeFailure(Machine.decodeSnapshot(topologyMachine, mutation), "configuration")
      }
    }))

  it.effect("rejects invalid and corrupt completion entries", () =>
    Effect.gen(function*() {
      const encoded = yield* Machine.encodeSnapshot(topologyMachine, topologyFinal())
      const mutations: Array<unknown> = []

      const unknown = structuredClone(encoded) as any
      unknown.completed[0].path = "Root.left.missing"
      mutations.push(unknown)

      const duplicate = structuredClone(encoded) as any
      duplicate.completed.push(structuredClone(duplicate.completed[0]))
      mutations.push(duplicate)

      const wrongOutput = structuredClone(encoded) as any
      wrongOutput.completed[0].output = null
      mutations.push(wrongOutput)

      const activeNotFinal = yield* Machine.encodeSnapshot(topologyMachine, topologyActive())
      ;(activeNotFinal as any).completed = [{ path: "Root.left.working" as const, output: undefined }]
      mutations.push(activeNotFinal)

      const inactiveFinal = yield* Machine.encodeSnapshot(topologyMachine, topologyActive())
      ;(inactiveFinal as any).completed = [{ path: "Root.left.done" as const, output: "1" }]
      mutations.push(inactiveFinal)

      for (const mutation of mutations) {
        yield* expectDecodeFailure(Machine.decodeSnapshot(topologyMachine, mutation))
      }
    }))

  it.effect("rejects invalid logical completion entries before encoding", () =>
    Effect.gen(function*() {
      const final = topologyFinal()
      const active = topologyActive()
      const malformed: ReadonlyArray<unknown> = [
        { ...final, completed: [...(final.completed ?? []), final.completed?.[0]] },
        { ...final, completed: [{ path: "Root.left.missing" as const, output: 1 }] },
        { ...active, completed: [{ path: "Root.left.working" as const, output: undefined }] },
        { ...final, completed: [{ path: "Root.left.done" as const, output: null }] }
      ]

      for (const snapshot of malformed) {
        yield* expectEncodeFailure(snapshot)
      }
    }))

  it.effect("rejects schema failures on both sides of the codec", () =>
    Effect.gen(function*() {
      const logical = topologyActive()
      const invalidLogical = {
        ...logical,
        states: {
          ...logical.states,
          left: {
            ...logical.states.left,
            state: {
              ...logical.states.left.state,
              value: { _tag: "CodecLeftWorking", task: "" }
            }
          }
        }
      }
      yield* expectEncodeFailure(invalidLogical, "state")

      const encoded = yield* Machine.encodeSnapshot(topologyMachine, logical)
      const invalidEncoded = structuredClone(encoded) as any
      invalidEncoded.active.find((entry: any) => entry.path === "Root.left.working").value.task = ""
      yield* expectDecodeFailure(Machine.decodeSnapshot(topologyMachine, invalidEncoded), "state")
    }))

  it.effect("rejects corrupt history paths, modes, values, and control records", () =>
    Effect.gen(function*() {
      const encoded = yield* Machine.encodeSnapshot(historyMachine, historySnapshot())
      const mutations: Array<unknown> = []

      const unknownRecord = structuredClone(encoded) as any
      unknownRecord.history["Workspace.missing"] = unknownRecord.history["Workspace.exact"]
      mutations.push(unknownRecord)

      const wrongMode = structuredClone(encoded) as any
      wrongMode.history["Workspace.exact"].mode = "shallow"
      mutations.push(wrongMode)

      const duplicatePath = structuredClone(encoded) as any
      duplicatePath.history["Workspace.exact"].active.push("Workspace.Editor")
      mutations.push(duplicatePath)

      const missingOwner = structuredClone(encoded) as any
      missingOwner.history["Workspace.exact"].active = missingOwner.history["Workspace.exact"].active.filter(
        (path: string) => path !== "Workspace"
      )
      delete missingOwner.history["Workspace.exact"].values.Workspace
      mutations.push(missingOwner)

      const extraValue = structuredClone(encoded) as any
      extraValue.history["Workspace.exact"].values["Workspace.Editor.preview"] = {
        _tag: "CodecPreview",
        page: 1
      }
      mutations.push(extraValue)

      const invalidValue = structuredClone(encoded) as any
      invalidValue.history["Workspace.exact"].values["Workspace.Editor.editing"].contents = 1
      mutations.push(invalidValue)

      const incompleteCompound = structuredClone(encoded) as any
      incompleteCompound.history["Workspace.exact"].active = ["Workspace", "Workspace.Editor"]
      delete incompleteCompound.history["Workspace.exact"].values["Workspace.Editor.editing"]
      mutations.push(incompleteCompound)

      const shallowWithDeepDescendant = structuredClone(encoded) as any
      shallowWithDeepDescendant.history["Workspace.recent"].active.push("Workspace.Editor.editing")
      shallowWithDeepDescendant.history["Workspace.recent"].values["Workspace.Editor.editing"] = {
        _tag: "CodecEditing",
        contents: "hello"
      }
      mutations.push(shallowWithDeepDescendant)

      const conflictingCompoundChildren = structuredClone(encoded) as any
      conflictingCompoundChildren.history["Workspace.exact"].active.push("Workspace.Editor.preview")
      conflictingCompoundChildren.history["Workspace.exact"].values["Workspace.Editor.preview"] = {
        _tag: "CodecPreview",
        page: 1
      }
      mutations.push(conflictingCompoundChildren)

      const outsideOwner = structuredClone(encoded) as any
      outsideOwner.history["Workspace.exact"].active.push("Outside")
      outsideOwner.history["Workspace.exact"].values.Outside = { _tag: "CodecOutside" }
      mutations.push(outsideOwner)

      for (const mutation of mutations) {
        yield* expectDecodeFailure(Machine.decodeSnapshot(historyMachine, mutation), "history")
      }
    }))

  it.effect("rejects corrupt logical history before encoding", () =>
    Effect.gen(function*() {
      const snapshot = historySnapshot()
      const invalid: ReadonlyArray<unknown> = [
        {
          ...snapshot,
          history: {
            ...snapshot.history,
            "Workspace.exact": {
              ...snapshot.history?.["Workspace.exact"],
              mode: "shallow"
            }
          }
        },
        {
          ...snapshot,
          history: {
            ...snapshot.history,
            "Workspace.exact": {
              ...snapshot.history?.["Workspace.exact"],
              active: [...snapshot.history!["Workspace.exact"]!.active, "Workspace.Editor.preview"],
              values: {
                ...snapshot.history!["Workspace.exact"]!.values,
                "Workspace.Editor.preview": new Preview({ page: 1 })
              }
            }
          }
        },
        {
          ...snapshot,
          history: {
            ...snapshot.history,
            "Workspace.exact": {
              ...snapshot.history?.["Workspace.exact"],
              active: [...snapshot.history!["Workspace.exact"]!.active, "Outside"],
              values: {
                ...snapshot.history!["Workspace.exact"]!.values,
                Outside: new Outside({})
              }
            }
          }
        }
      ]

      for (const malformed of invalid) {
        const error = yield* Machine.encodeSnapshot(historyMachine, malformed as any).pipe(Effect.flip)
        assert.instanceOf(error, Machine.MachineSchemaEncodeError)
        assert.strictEqual(error.boundary, "history")
      }
    }))
})
