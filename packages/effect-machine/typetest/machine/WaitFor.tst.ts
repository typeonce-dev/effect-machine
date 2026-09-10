import type { Cause, Effect } from "effect"
import { pipe } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"

type Snapshot = Machine.RuntimeSnapshot<{ readonly value: number }, "failed", string>
declare const ref: Machine.MachineRef<
  { readonly value: number },
  { readonly _tag: "Go" },
  "failed",
  string,
  { readonly _tag: "Notice" }
>
type Failure = "failed" | Machine.StoppedError | Cause.NoSuchElementError
const isDone = (snapshot: Snapshot): snapshot is Extract<Snapshot, { status: "done" }> => snapshot.status === "done"

describe("Machine.waitFor", () => {
  it("preserves snapshots, errors, and service-free observation", () => {
    const waiting = Machine.waitFor(ref, (snapshot): boolean => snapshot.state.value > 1)
    expect<Effect.Success<typeof waiting>>().type.toBe<Snapshot>()
    expect<Effect.Error<typeof waiting>>().type.toBe<Failure>()
    expect<Effect.Services<typeof waiting>>().type.toBe<never>()
  })
  it("narrows both calling forms", () => {
    const direct = Machine.waitFor(ref, isDone)
    const curried = pipe(ref, Machine.waitFor(isDone))
    expect<Effect.Success<typeof direct>>().type.toBe<Extract<Snapshot, { status: "done" }>>()
    expect<Effect.Success<typeof curried>>().type.toBe<Extract<Snapshot, { status: "done" }>>()
    expect<Effect.Error<typeof curried>>().type.toBe<Failure>()
    const inline = pipe(ref, Machine.waitFor((snapshot) => snapshot.status === "done"))
    expect<Effect.Error<typeof inline>>().type.toBe<Failure>()
    expect<Effect.Success<typeof inline>>().type.toBe<Extract<Snapshot, { status: "done" }>>()
  })
  it("rejects unrelated predicates and nonboolean results", () => {
    expect(Machine.waitFor).type.not.toBeCallableWith(
      ref,
      (snapshot: Machine.RuntimeSnapshot<string>) => snapshot.state.length > 0
    )
    expect(Machine.waitFor).type.not.toBeCallableWith(ref, () => 1)
  })
})
