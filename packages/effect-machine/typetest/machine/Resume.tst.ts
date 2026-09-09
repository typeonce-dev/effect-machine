import { Effect, Schema } from "effect"
import { Atom } from "effect/unstable/reactivity"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"
import { AtomMachine } from "../../src/unstable/reactivity/index.js"
class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", { value: Schema.Number }) {}
class Tick extends Schema.TaggedClass<Tick>("Tick")("Tick", {}) {}
const States = Machine.state({
  fields: {
    input: Schema.toType(Schema.Struct({ seed: Schema.Number }))
  },
  states: { Idle }
})
type Snapshot = Machine.Snapshot<typeof States>
const targets1 = Machine.targets(States)
const machine = Machine.make({
  root: States,
  events: Machine.eventsFromSchemas(Tick),
  input: Schema.Struct({ seed: Schema.Number })
}).handle({
  initial: {
    target: Machine.targets(States).root.Idle,
    decoded: true,
    data: ({ root: { input: input } }) => new Idle({ value: input.seed })
  },
  root: ({ input }) => ({ input }),
  states: {
    Idle: {
      on: {
        Tick: { target: targets1.root.Idle, decoded: true, data: ({ state }) => (new Idle({ value: state.value + 1 })) }
      }
    }
  }
})
const snapshot: Snapshot = {
  path: "" as const,
  value: { _tag: "", input: { seed: 0 } },
  state: { path: "Idle", value: new Idle({ value: 3 }) }
}
describe("Machine logical resumption", () => {
  it("excludes input while preserving synchronous runtime inference", () => {
    const resumed = Machine.resume(machine, snapshot)
    type Ref = Effect.Success<typeof resumed>
    expect<Effect.Error<typeof resumed>>().type.toBe<Machine.MachineSchemaDecodeError>()
    expect<Effect.Services<typeof resumed>>().type.toBe<never>()
    expect<Effect.Error<Ref["join"]>>().type.toBe<
      Machine.InfiniteTransitionError | Machine.MachineSchemaDecodeError | Machine.StoppedError
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
