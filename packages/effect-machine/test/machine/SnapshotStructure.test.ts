import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { Machine } from "../../src/index.js"
it.effect("planning and encoding reject malformed snapshots through typed failures", () =>
  Effect.gen(function*() {
    const InitialRoot1 = Machine.state({
      type: "parallel",
      states: {
        Left: { states: { Ready: {} } },
        Right: {}
      }
    })
    const machine = Machine.make({
      root: InitialRoot1,
      events: Machine.events({ Ping: {} })
    }).handle({
      states: {
        Left: {
          initial: {
            target: Machine.targets(InitialRoot1).root.Left.Ready
          },
          states: {
            Ready: {}
          }
        },
        Right: {}
      }
    })
    const initial = yield* Machine.planInitial(machine)
    const state = initial.state
    const malformed: ReadonlyArray<unknown> = [
      { ...state, value: 1 },
      { ...state, states: undefined },
      { ...state, states: { Right: state.states.Right } },
      { ...state, states: { ...state.states, Left: state.states.Right } },
      { ...state, states: { ...state.states, Left: { ...state.states.Left, state: undefined } } },
      { ...state, states: { ...state.states, Left: { ...state.states.Left, state: state.states.Right } } }
    ]
    for (const value of malformed) {
      // Exercise untyped interop at both boundaries without manufacturing valid snapshots.
      const snapshot = value as Machine.Snapshot<typeof machine>
      const planning = yield* Effect.flip(Machine.plan(machine, snapshot, machine.events.Ping()))
      assert.instanceOf(planning, Machine.MachineSchemaDecodeError)
      const encoding = yield* Effect.flip(Machine.encodeSnapshot(machine, snapshot))
      assert.instanceOf(encoding, Machine.MachineSchemaEncodeError)
    }
    const encoded = yield* Machine.encodeSnapshot(machine, state)
    assert.deepStrictEqual(yield* Machine.decodeSnapshot(machine, encoded), state)
  }))
