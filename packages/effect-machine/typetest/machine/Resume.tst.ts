import { Effect, Schema } from "effect"
import { Atom } from "effect/unstable/reactivity"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"
import { AtomMachine } from "../../src/unstable/reactivity/index.js"

class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", { value: Schema.Number }) {}
class Tick extends Schema.TaggedClass<Tick>("Tick")("Tick", {}) {}

const States = Machine.state({ initial: "Idle", states: { Idle } })
type Snapshot = Machine.Snapshot<typeof States>

const machine = Machine.make({
  root: States,
  events: Machine.eventsFromSchemas(Tick),
  input: Schema.Struct({ seed: Schema.Number }),
  initialConfiguration: (root) =>
    root.resolve(({ input: input, target }) => (target.from((to) => to.Idle.decoded(new Idle({ value: input.seed })))))
}).handle({
  states: {
    Idle: {
      on: {
        Tick: (to) =>
          to.branch.Idle().resolve(({ state, target }) => target.decoded(new Idle({ value: state.value + 1 })))
      }
    }
  }
})

const snapshot: Snapshot = {
  path: "" as const,
  value: undefined,
  state: { path: "Idle", value: new Idle({ value: 3 }) }
}

describe("Machine logical resumption", () => {
  it("excludes input while preserving synchronous runtime inference", () => {
    const resumed = Machine.resume(machine, snapshot)
    type Ref = Effect.Success<typeof resumed>

    expect<Effect.Error<typeof resumed>>().type.toBe<Machine.MachineSchemaDecodeError>()
    expect<Effect.Services<typeof resumed>>().type.toBe<never>()
    expect<Effect.Error<Ref["join"]>>().type.toBe<
      | Machine.InfiniteTransitionError
      | Machine.MachineSchemaDecodeError
      | Machine.StoppedError
    >()
    expect<Effect.Success<Ref["state"]>>().type.toBe<Snapshot>()
    expect(Machine.resume).type.not.toBeCallableWith(machine, snapshot, { seed: 1 })
    expect(Machine.resume).type.not.toBeCallableWith(machine, {
      version: 2,
      _tag: "MachineSnapshot",
      active: [{ path: "" }, { path: "Idle", value: { _tag: "Idle", value: 3 } }]
    })
  })

  it("mirrors inference through the atom bridge", () => {
    const bridge = AtomMachine.resume(machine, snapshot)
    type RefFailure = Atom.Failure<typeof bridge.ref>
    type ResultFailure = Atom.Failure<typeof bridge.result>

    expect(AtomMachine.resume).type.toBeCallableWith(machine, snapshot)
    expect<RefFailure>().type.toBe<Machine.MachineSchemaDecodeError>()
    expect<Extract<ResultFailure, Machine.InfiniteTransitionError>>().type.toBe<Machine.InfiniteTransitionError>()
    expect<Atom.Success<typeof bridge.result>>().type.toBe<Snapshot>()
  })
})
