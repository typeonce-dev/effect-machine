import { strict as assert } from "node:assert"
import { test } from "node:test"
import { makeEffectMachineBenchmarkApi } from "../perf/runtime/effect-machine-compatibility.mjs"

test("adapts the state-definition constructor across the public rename", () => {
  const definitions = { Idle: "schema" }
  const current = makeEffectMachineBenchmarkApi({ states: (states) => ({ api: "current", states }) })
  const legacy = makeEffectMachineBenchmarkApi({ defineStates: (states) => ({ api: "legacy", states }) })

  assert.deepEqual(current.states(definitions), { api: "current", states: definitions })
  assert.deepEqual(legacy.states(definitions), { api: "legacy", states: definitions })
})

test("adapts wrapped static transition definitions when that capability is present", () => {
  const calls = []
  const targetless = (to) => to.none()
  const Machine = {
    logic: () => undefined,
    targetless,
    transition: (definition) => {
      calls.push(definition)
      return { static: definition }
    },
    invoke: (config) => config,
    events: (...schemas) => schemas
  }
  const api = makeEffectMachineBenchmarkApi(Machine)
  const definition = { target: (to) => to.selected, resolve: "resolved" }
  const legacy = () => undefined
  const selected = Symbol("selected")

  assert.equal(api.initial(definition, legacy).target({ selected }), selected)
  assert.equal(api.transition(definition, legacy).static.target({ selected }), selected)
  assert.deepEqual(api.targetless, { target: targetless })
  assert.equal(calls.length, 1)
})

test("adapts benchmark definitions to callable fluent transition selectors", () => {
  const calls = []
  const targetless = Object.assign((to) => to.none(), {
    "~effect/Machine/TargetlessSelector": true
  })
  const Machine = { targetless, invoke: (config) => config }
  const api = makeEffectMachineBenchmarkApi(Machine)
  const resolve = () => undefined
  const selected = {
    resolve: (...args) => {
      calls.push(args)
      return "resolved"
    }
  }
  const transition = api.transition({
    target: (to) => to.selected,
    resolve,
    reenter: true,
    declinable: true
  }, "legacy")

  assert.equal(transition({ selected }), "resolved")
  assert.deepEqual(calls, [[resolve, { reenter: true, declinable: true }]])
  assert.equal(typeof api.initial({ target: (to) => to.selected }, "legacy"), "object")
  assert.deepEqual(api.targetless, { target: targetless })
})

test("adapts benchmark definitions to value selectors and target-first initial entry", () => {
  const calls = []
  const Machine = { invoke: (config) => config }
  const api = makeEffectMachineBenchmarkApi(Machine)
  const selected = {
    resolve: (resolver) => {
      calls.push(resolver)
      return "resolved"
    }
  }
  const resolve = () => undefined
  const initial = api.initial({ target: (to) => to.selected, resolve }, "legacy")

  assert.equal(initial({ selected }), "resolved")
  assert.deepEqual(calls, [resolve])
  assert.equal(api.targetless({ none: selected }), selected)
})

test("uses the current child invocation capability when available", () => {
  const calls = []
  const noTarget = Symbol("no-target")
  const Machine = {
    events: (...schemas) => ({ api: "current-events", schemas }),
    invoke: (config) => {
      calls.push(config)
      return { api: "current", config }
    }
  }
  const config = { child: "counter", onDone: () => undefined }

  assert.deepEqual(makeEffectMachineBenchmarkApi(Machine).events("Increment", "Finish"), {
    api: "current-events",
    schemas: ["Increment", "Finish"]
  })

  assert.deepEqual(makeEffectMachineBenchmarkApi(Machine).invokeChild(config), {
    api: "current",
    config
  })
  assert.deepEqual(calls, [config])
  assert.equal(makeEffectMachineBenchmarkApi(Machine).targetless({ none: noTarget }), noTarget)
})

test("adapts lifecycle names for the legacy child invocation capability", () => {
  const calls = []
  const onDone = () => undefined
  const onSnapshot = () => undefined
  const Machine = {
    event: () => undefined,
    transition: (_initial, _transition) => {
      throw new Error("legacy process constructor must not capture state transitions")
    },
    invokeMachine: (config) => {
      calls.push(config)
      return { api: "legacy", config }
    }
  }

  assert.deepEqual(makeEffectMachineBenchmarkApi(Machine).events("Increment", "Finish"), ["Increment", "Finish"])
  assert.equal(makeEffectMachineBenchmarkApi(Machine).initial("static", onDone), onDone)
  assert.equal(makeEffectMachineBenchmarkApi(Machine).transition("static", onDone), onDone)

  assert.deepEqual(
    makeEffectMachineBenchmarkApi(Machine).invokeChild({
      child: "counter",
      input: { seed: 1 },
      onDone,
      onSnapshot
    }),
    {
      api: "legacy",
      config: {
        child: "counter",
        input: { seed: 1 },
        onDone,
        snapshot: onSnapshot
      }
    }
  )
  assert.deepEqual(calls, [{ child: "counter", input: { seed: 1 }, onDone, snapshot: onSnapshot }])
  assert.equal(makeEffectMachineBenchmarkApi(Machine).targetless({ target: {} }), undefined)
})

test("fails closed when a legacy capability cannot preserve lifecycle semantics", () => {
  const Machine = { invokeMachine: () => undefined }

  assert.throws(
    () =>
      makeEffectMachineBenchmarkApi(Machine).invokeChild({
        child: "counter",
        onFailure: () => undefined
      }),
    /legacy child invocation API cannot handle failures/
  )
})
