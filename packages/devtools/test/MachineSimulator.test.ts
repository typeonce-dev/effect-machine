import { assert, describe, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import { machine } from "../src/internal/browser/example-machine.js"
import * as MachineDocument from "../src/MachineDocument.js"
import * as MachineSimulator from "../src/MachineSimulator.js"

describe("MachineSimulator", () => {
  const document = MachineDocument.make(machine)

  it("enters compound and parallel initial states without running the machine", () => {
    const session = MachineSimulator.start(document)
    assert.deepStrictEqual(session.snapshot.activePaths, [
      "application",
      "application.workflow",
      "application.workflow.idle",
      "application.connection",
      "application.connection.online"
    ])
    assert.deepStrictEqual(session.snapshot.candidateEvents, ["Disconnect", "Refresh", "Start"])
  })

  it("applies a statically direct transition and preserves the parallel region", () => {
    const started = MachineSimulator.start(document)
    const result = MachineSimulator.send(started, "Start")
    assert.strictEqual(result._tag, "Applied")
    if (result._tag === "Applied") {
      assert.deepStrictEqual(result.session.activePaths, [
        "application",
        "application.workflow",
        "application.workflow.running",
        "application.workflow.running.editing",
        "application.connection",
        "application.connection.online"
      ])
      assert.deepStrictEqual(result.session.candidateEvents, ["Disconnect", "Finish"])
      assert.deepStrictEqual(Schema.decodeUnknownSync(MachineSimulator.StepResult)(result), result)
    }
  })

  it("does not guess whether a declinable transition accepts an event", () => {
    const transition = document.transitions.find((transition) => transition.trigger.type === "event")!
    const guarded = {
      ...document,
      transitions: document.transitions.map((candidate) =>
        candidate.id === transition.id ? { ...candidate, acceptance: "declinable" as const } : candidate
      )
    }
    const result = MachineSimulator.send(MachineSimulator.start(guarded), "Start")
    assert.strictEqual(result._tag, "Indeterminate")
    if (result._tag === "Indeterminate") assert.strictEqual(result.reason, "declinable-transition")
  })

  it("blocks events that are not registered in the active configuration", () => {
    const result = MachineSimulator.send(MachineSimulator.start(document), "Finish")
    assert.strictEqual(result._tag, "Blocked")
  })
})
