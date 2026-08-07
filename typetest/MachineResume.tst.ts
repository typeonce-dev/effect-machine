import { Context, Effect, Layer, Schema } from "effect"
import { AsyncResult, Atom } from "effect/unstable/reactivity"
import { describe, expect, it } from "tstyche"
import { Machine } from "../src/index.js"
import { AtomMachine } from "../src/reactivity.js"

class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", { value: Schema.Number }) {}
class Tick extends Schema.TaggedClass<Tick>("Tick")("Tick", {}) {}
class InitialService extends Context.Service<InitialService, string>()("test/resume/InitialService") {}
class RuntimeService extends Context.Service<RuntimeService, string>()("test/resume/RuntimeService") {}
class InitialFailure {
  readonly _tag = "InitialFailure"
}
class RuntimeFailure {
  readonly _tag = "RuntimeFailure"
}
class LayerFailure {
  readonly _tag = "LayerFailure"
}

const States = Machine.defineStates({ Idle })
type Snapshot = Machine.Machine.Snapshot<typeof States.states>

const machine = Machine.make({
  states: States.states,
  events: [Tick],
  input: Schema.Struct({ seed: Schema.Number }),
  initial: (_input) =>
    Effect.succeed(States.initial.Idle(new Idle({ value: 0 }))) as Effect.Effect<
      Snapshot,
      InitialFailure,
      InitialService
    >
}).handle({
  Idle: {
    on: {
      Tick: ({ state, target }) =>
        Effect.succeed(target.full.Idle(new Idle({ value: state.value + 1 }))) as Effect.Effect<
          Snapshot,
          RuntimeFailure,
          RuntimeService
        >
    }
  }
})

const snapshot = States.initial.Idle(new Idle({ value: 3 }))

describe("Machine logical resumption", () => {
  it("excludes input and initial-only channels while preserving runtime inference", () => {
    const resumed = Machine.resume(machine, snapshot)
    type Ref = Effect.Success<typeof resumed>

    expect<Effect.Error<typeof resumed>>().type.toBe<Machine.MachineSchemaDecodeError>()
    expect<Effect.Services<typeof resumed>>().type.toBe<RuntimeService>()
    expect<Effect.Error<Ref["join"]>>().type.toBe<
      | RuntimeFailure
      | Machine.InfiniteTransitionError
      | Machine.MachineSchemaDecodeError
      | Machine.StoppedError
    >()
    expect<Effect.Success<Ref["state"]>>().type.toBe<Snapshot>()
    expect(Machine.resume).type.not.toBeCallableWith(machine, snapshot, { seed: 1 })
    expect(Machine.resume).type.not.toBeCallableWith(machine, {
      _tag: "MachineSnapshot",
      active: [{ path: "Idle", value: { _tag: "Idle", value: 3 } }]
    })
  })

  it("mirrors inference through direct and bound atom bridges", () => {
    const runtime = Atom.runtime(Layer.succeed(RuntimeService, "runtime"))
    const failingRuntime = Atom.runtime(
      Layer.merge(
        Layer.succeed(RuntimeService, "runtime"),
        Layer.effectDiscard(Effect.fail(new LayerFailure()))
      )
    )
    const bound = AtomMachine.bind(runtime)
    const bridge = bound.resume(machine, snapshot)
    const failing = AtomMachine.bind(failingRuntime).resume(machine, snapshot)
    type RefFailure = Atom.Failure<typeof bridge.ref>
    type ResultFailure = Atom.Failure<typeof bridge.result>

    expect(AtomMachine.resume).type.not.toBeCallableWith(machine, snapshot)
    expect(bound.resume).type.toBeCallableWith(machine, snapshot)
    expect<RefFailure>().type.toBe<Machine.MachineSchemaDecodeError>()
    expect<Extract<ResultFailure, RuntimeFailure>>().type.toBe<RuntimeFailure>()
    expect<Extract<Atom.Failure<typeof failing.ref>, LayerFailure>>().type.toBe<LayerFailure>()
    expect<Atom.Success<typeof bridge.state>>().type.toBe<Snapshot>()
    expect<typeof bridge.ref>().type.toBe<
      Atom.Atom<
        AsyncResult.AsyncResult<
          Machine.MachineRef<
            Snapshot,
            Tick,
            | RuntimeFailure
            | Machine.ActionError<RuntimeService>
            | Machine.InfiniteTransitionError
            | Machine.MachineSchemaDecodeError
            | Machine.StoppedError,
            never
          >,
          Machine.MachineSchemaDecodeError
        >
      >
    >()
  })
})
