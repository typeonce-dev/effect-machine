import { strict as assert } from "node:assert"
import { test } from "node:test"
import { makeEffectMachineBenchmarkApi } from "../perf/runtime/effect-machine-compatibility.mjs"

test("uses the current child invocation capability when available", () => {
  const calls = []
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
})

test("adapts lifecycle names for the legacy child invocation capability", () => {
  const calls = []
  const onDone = () => undefined
  const onSnapshot = () => undefined
  const Machine = {
    event: () => undefined,
    invokeMachine: (config) => {
      calls.push(config)
      return { api: "legacy", config }
    }
  }

  assert.deepEqual(makeEffectMachineBenchmarkApi(Machine).events("Increment", "Finish"), ["Increment", "Finish"])

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
