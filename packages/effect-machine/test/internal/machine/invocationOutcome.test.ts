import { assert, describe, it } from "@effect/vitest"
import { Cause, Exit } from "effect"
import { StoppedError } from "../../../src/internal/machine/errors.js"
import * as InvocationEvent from "../../../src/internal/machine/invocationEvent.js"
import * as InvocationOutcome from "../../../src/internal/machine/invocationOutcome.js"
import type * as InvocationResolution from "../../../src/internal/machine/invocationResolution.js"

const make = (
  channels: Partial<InvocationResolution.OutcomeChannels> = {}
): InvocationResolution.StreamInvocation => ({
  _tag: "Stream",
  path: "Working",
  id: "work",
  sourceName: "work",
  channels: { done: false, failure: false, element: false, snapshot: false, ...channels },
  stream: () => {
    throw new Error("A decision never constructs the source")
  }
})

const makeChild = (): InvocationResolution.ChildInvocation => ({
  _tag: "Child",
  path: "Working",
  id: "work",
  channels: { done: false, failure: true, element: false, snapshot: false },
  child: {} as InvocationResolution.ChildInvocation["child"],
  input: undefined
})

const current = (): InvocationEvent.Generation => ({ current: true })

describe("invocation outcome policy", () => {
  it("delivers a declared completion and fails its owner otherwise", () => {
    const generation = current()
    const done: InvocationOutcome.Outcome = { _tag: "Done", output: 1 }
    assert.deepStrictEqual(InvocationOutcome.decide(make({ done: true }), generation, done), {
      _tag: "Deliver",
      event: InvocationEvent.done("Working", "work", generation, 1)
    })
    const decision = InvocationOutcome.decide(make(), generation, done)
    if (decision._tag !== "Fail") throw new Error(`Unexpected ${decision._tag}`)
    assert.strictEqual(
      (Cause.squash(decision.cause) as Error).message,
      "Invocation \"work\" completed without the required onDone handler"
    )
    assert.isTrue(Cause.hasDies(decision.cause))
  })

  it("delivers a declared failure and fails its owner with the cause otherwise", () => {
    const generation = current()
    const cause = Cause.fail("unavailable")
    const failure: InvocationOutcome.Outcome = { _tag: "Failure", error: "unavailable", cause }
    assert.deepStrictEqual(InvocationOutcome.decide(make({ failure: true }), generation, failure), {
      _tag: "Deliver",
      event: InvocationEvent.failure("Working", "work", generation, "unavailable")
    })
    assert.deepStrictEqual(InvocationOutcome.decide(make(), generation, failure), { _tag: "Fail", cause })
  })

  it("fails the owner when a child machine reports a framework failure", () => {
    const generation = current()
    const error = new StoppedError()
    const failure: InvocationOutcome.Outcome = { _tag: "Failure", error, cause: Cause.fail(error) }
    assert.deepStrictEqual(InvocationOutcome.decide(makeChild(), generation, failure), {
      _tag: "Fail",
      cause: failure.cause
    })
    assert.strictEqual(InvocationOutcome.decide(make({ failure: true }), generation, failure)._tag, "Deliver")
    assert.strictEqual(
      InvocationOutcome.decide(makeChild(), generation, { ...failure, error: "declared" })._tag,
      "Deliver"
    )
  })

  it("fails the owner with every cause that has no typed failure", () => {
    const cause = Cause.die("boom")
    for (const _tag of ["Defect", "Interrupted", "Cause"] as const) {
      assert.deepStrictEqual(
        InvocationOutcome.decide(make({ done: true, failure: true }), current(), { _tag, cause }),
        { _tag: "Fail", cause }
      )
    }
  })

  it("ignores stopped work and every report of a retired generation", () => {
    const invocation = make({ done: true, failure: true, element: true, snapshot: true })
    assert.deepStrictEqual(InvocationOutcome.decide(invocation, current(), { _tag: "Stopped" }), { _tag: "Ignore" })
    const retired: InvocationEvent.Generation = { current: false }
    for (
      const outcome of [
        { _tag: "Done", output: 1 },
        { _tag: "Failure", error: "unavailable", cause: Cause.fail("unavailable") },
        { _tag: "Defect", cause: Cause.die("boom") }
      ] satisfies ReadonlyArray<InvocationOutcome.Outcome>
    ) {
      assert.deepStrictEqual(InvocationOutcome.decide(invocation, retired, outcome), { _tag: "Ignore" })
    }
    assert.deepStrictEqual(InvocationOutcome.decideSnapshot(invocation, retired, 1), { _tag: "Ignore" })
    assert.deepStrictEqual(InvocationOutcome.decideElement(invocation, retired, 1), { _tag: "Ignore" })
  })

  it("delivers declared snapshots, and elements whether or not they are declared", () => {
    const generation = current()
    assert.deepStrictEqual(InvocationOutcome.decideSnapshot(make({ snapshot: true }), generation, 1), {
      _tag: "Deliver",
      event: InvocationEvent.snapshot("Working", "work", generation, 1)
    })
    assert.deepStrictEqual(InvocationOutcome.decideSnapshot(make(), generation, 1), { _tag: "Ignore" })
    for (const element of [true, false]) {
      assert.deepStrictEqual(InvocationOutcome.decideElement(make({ element }), generation, 1), {
        _tag: "Deliver",
        event: InvocationEvent.element("Working", "work", generation, 1)
      })
    }
  })

  it("reads an outcome from an exit, preferring a typed failure", () => {
    assert.deepStrictEqual(InvocationOutcome.fromExit(Exit.succeed(1)), { _tag: "Done", output: 1 })
    const mixed = Cause.combine(Cause.die("boom"), Cause.fail("unavailable"))
    assert.deepStrictEqual(InvocationOutcome.fromExit(Exit.failCause(mixed)), {
      _tag: "Failure",
      error: "unavailable",
      cause: mixed
    })
    const defect = Cause.die("boom")
    assert.deepStrictEqual(InvocationOutcome.fromExit(Exit.failCause(defect)), { _tag: "Cause", cause: defect })
  })
})
