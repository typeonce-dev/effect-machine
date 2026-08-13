import { strict as assert } from "node:assert"
import { test } from "node:test"
import { findRuntimePerformanceRegressions } from "./runtime-performance-regression.mjs"

const report = ({ heap = 1_000, heapMad = 2, throughput = 1_000, throughputMad = 2 } = {}) => ({
  benchmarks: [{
    id: "runtime-burst",
    implementation: "effect-machine",
    label: "Drain burst",
    medianThroughput: throughput,
    processRelativeMad: throughputMad,
    unit: "events/s"
  }],
  memory: [{
    implementation: "effect-machine",
    profiles: [{
      heapBytesPerIdleMachine: heap,
      id: "idle",
      label: "Idle machine",
      processRelativeMad: heapMad
    }]
  }]
})

test("accepts changes within the fixed regression floors", () => {
  assert.deepEqual(
    findRuntimePerformanceRegressions(report(), report({ heap: 1_190, throughput: 860 })),
    []
  )
})

test("rejects large throughput and heap regressions", () => {
  assert.deepEqual(
    findRuntimePerformanceRegressions(report(), report({ heap: 1_250, throughput: 800 })),
    [
      {
        changePercent: 20,
        id: "runtime-burst",
        kind: "throughput",
        label: "Drain burst",
        thresholdPercent: 15
      },
      {
        changePercent: 25,
        id: "idle",
        kind: "heap",
        label: "Idle machine",
        thresholdPercent: 20
      }
    ]
  )
})

test("uses process variability when it exceeds the fixed floor", () => {
  assert.deepEqual(
    findRuntimePerformanceRegressions(
      report({ heapMad: 10, throughputMad: 10 }),
      report({ heap: 1_250, heapMad: 10, throughput: 800, throughputMad: 10 })
    ),
    []
  )
})

test("ignores unrelated implementations", () => {
  const base = report()
  const pullRequest = report({ heap: 1_500, throughput: 500 })
  pullRequest.benchmarks[0].implementation = "reference"
  pullRequest.memory[0].implementation = "reference"
  assert.deepEqual(findRuntimePerformanceRegressions(base, pullRequest), [])
})
