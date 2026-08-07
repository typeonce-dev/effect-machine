import process from "node:process"
import { setImmediate as yieldToEventLoop } from "node:timers/promises"
import { implementations } from "./implementations.mjs"

if (typeof globalThis.gc !== "function") {
  throw new Error("Runtime memory benchmarks require Node.js with --expose-gc")
}

const implementationId = process.argv[2]
const counts = JSON.parse(process.argv[3] ?? "[]")
const implementation = implementations.find((candidate) => candidate.implementation === implementationId)

if (implementation === undefined) {
  throw new Error(`Unknown runtime benchmark implementation: ${implementationId}`)
}

const collectGarbage = async () => {
  for (let index = 0; index < 3; index += 1) {
    globalThis.gc()
    await yieldToEventLoop()
  }
}

const linearSlope = (points, value) => {
  const withBaseline = [{ machines: 0, [value]: 0 }, ...points]
  const meanX = withBaseline.reduce((total, point) => total + point.machines, 0) / withBaseline.length
  const meanY = withBaseline.reduce((total, point) => total + point[value], 0) / withBaseline.length
  let numerator = 0
  let denominator = 0
  for (const point of withBaseline) {
    numerator += (point.machines - meanX) * (point[value] - meanY)
    denominator += (point.machines - meanX) ** 2
  }
  return numerator / denominator
}

// Trigger implementation-specific lazy initialization before taking the baseline.
const warmup = await implementation.startCounter()
await implementation.stopCounter(warmup)
await collectGarbage()

const baseline = process.memoryUsage()
const points = []
const refs = []

try {
  for (const count of counts) {
    refs.push(...await implementation.startCounters(count - refs.length))
    await collectGarbage()
    const usage = process.memoryUsage()
    points.push({
      machines: count,
      heapUsedBytes: usage.heapUsed,
      heapDeltaBytes: usage.heapUsed - baseline.heapUsed,
      rssBytes: usage.rss,
      rssDeltaBytes: usage.rss - baseline.rss
    })
  }
} finally {
  await implementation.stopCounters(refs)
  await collectGarbage()
}

process.stdout.write(JSON.stringify({
  implementation: implementation.implementation,
  implementationLabel: implementation.label,
  implementationVersion: implementation.version,
  baseline: {
    heapUsedBytes: baseline.heapUsed,
    rssBytes: baseline.rss
  },
  points,
  heapBytesPerIdleMachine: linearSlope(points, "heapDeltaBytes")
}))
