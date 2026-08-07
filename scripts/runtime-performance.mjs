import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { cpus, freemem, platform, release, totalmem } from "node:os"
import { resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { Bench } from "tinybench"
import { implementations, packageVersions } from "../perf/runtime/implementations.mjs"
const sourceRevision = (() => {
  try {
    return {
      commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      dirty: execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
        encoding: "utf8"
      }).trim().length > 0
    }
  } catch {
    return { commit: null, dirty: null }
  }
})()

const options = {
  json: false,
  output: undefined,
  quick: false
}

for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index]
  if (argument === "--") {
    continue
  } else if (argument === "--json") {
    options.json = true
  } else if (argument === "--quick") {
    options.quick = true
  } else if (argument === "--output") {
    const output = process.argv[index + 1]
    if (output === undefined) {
      throw new Error("--output requires a file path")
    }
    options.output = resolve(output)
    index += 1
  } else {
    throw new Error(`Unknown argument: ${argument}`)
  }
}

if (typeof globalThis.gc !== "function") {
  throw new Error("Runtime benchmarks require Node.js with --expose-gc")
}

const configuration = options.quick
  ? {
    timeMilliseconds: 100,
    warmupTimeMilliseconds: 25,
    minimumIterations: 2,
    minimumWarmupIterations: 1,
    planningBatchSize: 25,
    burstBatchSize: 25,
    memoryCounts: [25, 100]
  }
  : {
    timeMilliseconds: 1_000,
    warmupTimeMilliseconds: 250,
    minimumIterations: 10,
    minimumWarmupIterations: 5,
    planningBatchSize: 100,
    burstBatchSize: 250,
    memoryCounts: [100, 500, 1_000]
  }

const bench = new Bench({
  time: configuration.timeMilliseconds,
  warmupTime: configuration.warmupTimeMilliseconds,
  iterations: configuration.minimumIterations,
  warmupIterations: configuration.minimumWarmupIterations,
  throws: true
})
const benchmarkDefinitions = new Map()
const activeBurstRefs = new Map()

for (const implementation of implementations) {
  const metadata = {
    implementation: implementation.implementation,
    implementationLabel: implementation.label,
    implementationVersion: implementation.version
  }
  const planningTask = `${implementation.implementation}:plan-counter`
  benchmarkDefinitions.set(planningTask, {
    ...metadata,
    id: "plan-counter",
    label: "Plan counter transitions",
    unit: "transitions/s",
    operationsPerIteration: configuration.planningBatchSize
  })
  bench.add(planningTask, () => {
    const value = implementation.planCounterBatch(configuration.planningBatchSize)
    if (value !== configuration.planningBatchSize) {
      throw new Error(
        `${implementation.label} planning benchmark produced ${value}, expected ${configuration.planningBatchSize}`
      )
    }
  })

  const burstTask = `${implementation.implementation}:runtime-burst`
  benchmarkDefinitions.set(burstTask, {
    ...metadata,
    id: "runtime-burst",
    label: "Drain burst with terminal fence",
    unit: "increments/s",
    operationsPerIteration: configuration.burstBatchSize,
    fenceEventsPerIteration: 1
  })
  const runBurst = implementation.async
    ? async () => {
      const value = await implementation.runCounterBurst(
        activeBurstRefs.get(implementation.implementation),
        configuration.burstBatchSize
      )
      if (value !== configuration.burstBatchSize) {
        throw new Error(
          `${implementation.label} runtime benchmark produced ${value}, expected ${configuration.burstBatchSize}`
        )
      }
    }
    : () => {
      const value = implementation.runCounterBurst(
        activeBurstRefs.get(implementation.implementation),
        configuration.burstBatchSize
      )
      if (value !== configuration.burstBatchSize) {
        throw new Error(
          `${implementation.label} runtime benchmark produced ${value}, expected ${configuration.burstBatchSize}`
        )
      }
    }
  bench.add(burstTask, runBurst, {
    beforeEach: async () => {
      activeBurstRefs.set(implementation.implementation, await implementation.startCounter())
    },
    afterEach: async () => {
      const ref = activeBurstRefs.get(implementation.implementation)
      await implementation.stopCounter(ref)
      activeBurstRefs.delete(implementation.implementation)
    }
  })

  const lifecycleTask = `${implementation.implementation}:start-stop`
  benchmarkDefinitions.set(lifecycleTask, {
    ...metadata,
    id: "start-stop",
    label: "Start and stop a machine",
    unit: "machines/s",
    operationsPerIteration: 1
  })
  bench.add(
    lifecycleTask,
    implementation.async
      ? async () => {
        await implementation.runLifecycle()
      }
      : () => implementation.runLifecycle()
  )
}

try {
  await bench.warmup()
  await bench.run()
} finally {
  for (const implementation of implementations) {
    const ref = activeBurstRefs.get(implementation.implementation)
    if (ref !== undefined) {
      await implementation.stopCounter(ref)
      activeBurstRefs.delete(implementation.implementation)
    }
  }
}

const percentile = (samples, quantile) =>
  samples[Math.max(0, Math.ceil(samples.length * quantile) - 1)]

const benchmarks = bench.tasks.map((task) => {
  const definition = benchmarkDefinitions.get(task.name)
  const result = task.result
  if (definition === undefined || result === undefined) {
    throw new Error(`Missing benchmark result for ${task.name}`)
  }
  if (result.error !== undefined) {
    throw result.error
  }
  const operations = definition.operationsPerIteration
  const medianBatchMilliseconds = percentile(result.samples, 0.5)
  return {
    ...definition,
    medianThroughput: operations * 1_000 / medianBatchMilliseconds,
    meanThroughput: result.hz * operations,
    meanNanosecondsPerOperation: result.mean * 1_000_000 / operations,
    medianBatchMilliseconds,
    p95BatchMilliseconds: percentile(result.samples, 0.95),
    p99BatchMilliseconds: result.p99,
    relativeMarginOfError: result.rme,
    sampleCount: result.samples.length
  }
})

const memoryWorker = fileURLToPath(new URL("../perf/runtime/memory-worker.mjs", import.meta.url))
const memory = implementations.map((implementation) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      ["--expose-gc", memoryWorker, implementation.implementation, JSON.stringify(configuration.memoryCounts)],
      { encoding: "utf8" }
    )
  )
)

const cpu = cpus()[0]
const report = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  source: sourceRevision,
  environment: {
    node: process.version,
    platform: platform(),
    release: release(),
    architecture: process.arch,
    cpu: cpu?.model ?? "unknown",
    logicalCpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
    packages: packageVersions
  },
  configuration,
  benchmarks,
  memory
}

const json = `${JSON.stringify(report, null, 2)}\n`
if (options.output !== undefined) {
  writeFileSync(options.output, json, "utf8")
}

if (options.json) {
  process.stdout.write(json)
} else {
  const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })
  const decimal = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const bytes = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 })
  const formatBytes = (value) => `${bytes.format(value / 1_024)} KiB`
  const formatDuration = (nanoseconds) =>
    nanoseconds >= 1_000_000
      ? `${decimal.format(nanoseconds / 1_000_000)} ms`
      : nanoseconds >= 1_000
      ? `${decimal.format(nanoseconds / 1_000)} µs`
      : `${decimal.format(nanoseconds)} ns`

  console.log(`Runtime performance (${process.version}, ${cpu?.model ?? "unknown"})\n`)
  console.table(
    benchmarks.map((result) => ({
      Implementation: `${result.implementationLabel} ${result.implementationVersion}`,
      Scenario: result.label,
      "Median throughput": `${integer.format(result.medianThroughput)} ${result.unit}`,
      "Mean/op": formatDuration(result.meanNanosecondsPerOperation),
      "p95 batch": `${decimal.format(result.p95BatchMilliseconds)} ms`,
      Margin: `±${decimal.format(result.relativeMarginOfError)}%`,
      Samples: integer.format(result.sampleCount)
    }))
  )

  console.log("\nIdle machine memory after forced GC\n")
  console.table(
    memory.flatMap((result) =>
      result.points.map((point) => ({
        Implementation: `${result.implementationLabel} ${result.implementationVersion}`,
        Machines: integer.format(point.machines),
        "Heap delta": formatBytes(point.heapDeltaBytes),
        "Heap/machine": formatBytes(point.heapDeltaBytes / point.machines),
        "RSS delta": formatBytes(point.rssDeltaBytes)
      }))
    )
  )
  for (const result of memory) {
    console.log(
      `${result.implementationLabel} heap slope: ${formatBytes(result.heapBytesPerIdleMachine)} per idle machine`
    )
    if (Number.isFinite(result.heapBytesPerIdleMachine) && result.heapBytesPerIdleMachine > 0) {
      console.log(
        `${result.implementationLabel} estimated idle capacity per GiB: ${integer.format(1_073_741_824 / result.heapBytesPerIdleMachine)} machines`
      )
    } else {
      console.log(`${result.implementationLabel} estimated idle capacity per GiB: unavailable`)
    }
  }
  console.log("RSS is an allocator-sensitive diagnostic; heap slope is the primary memory metric.")
  if (options.output !== undefined) {
    console.log(`\nJSON report written to ${options.output}`)
  }
  console.log("\nResults are informational. Compare runs made on the same machine and runtime configuration.")
}
