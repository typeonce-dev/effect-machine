import { Effect, Schema, Scope } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"
import { AtomMachine } from "../../src/unstable/reactivity/index.js"

class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
const machine = Machine.make({
  root: Machine.state({ states: { Idle } }),
  events: Machine.eventsFromSchemas()
}).handle({
  initial: { target: "Idle", decoded: true, data: new Idle({}) },
  states: { Idle: {} }
})

describe("Machine scoped lifetime", () => {
  it("requires a Scope to start, resume, and prepare", () => {
    const started = Machine.start(machine)
    expect<Effect.Services<typeof started>>().type.toBe<Scope.Scope>()
    const resumed = Machine.resume(machine, {
      path: "" as const,
      value: undefined,
      state: { path: "Idle", value: new Idle({}) }
    })
    expect<Effect.Services<typeof resumed>>().type.toBe<Scope.Scope>()
    const prepared = Machine.prepare(machine)
    expect<Effect.Services<typeof prepared>>().type.toBe<never>()
    expect<Effect.Services<Effect.Success<typeof prepared>["start"]>>().type.toBe<Scope.Scope>()
    expect(Effect.scoped(started)).type.toBe<
      Effect.Effect<Effect.Success<typeof started>, Effect.Error<typeof started>, never>
    >()
  })

  it("keeps machines acceptable by the Atom bridge", () => {
    expect(AtomMachine.make(machine)).type.not.toRaiseError()
  })
})
