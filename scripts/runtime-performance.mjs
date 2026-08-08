import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { cpus, freemem, platform, release, totalmem } from "node:os"
import { resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { Bench } from "tinybench"
import { implementations, memoryImplementations, packageVersions } from "../perf/runtime/implementations.mjs"
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
    childBatchSize: 10,
    memoryCounts: [25, 100]
  }
  : {
    timeMilliseconds: 1_000,
    warmupTimeMilliseconds: 250,
    minimumIterations: 10,
    minimumWarmupIterations: 5,
    planningBatchSize: 100,
    burstBatchSize: 250,
    childBatchSize: 100,
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
const activeChildRefs = new Map()
const activeObservedRefs = new Map()

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

  const observedBurstTask = `${implementation.implementation}:observed-runtime-burst`
  benchmarkDefinitions.set(observedBurstTask, {
    ...metadata,
    id: "observed-runtime-burst",
    label: "Drain burst with a change observer",
    unit: "increments/s",
    operationsPerIteration: configuration.burstBatchSize,
    fenceEventsPerIteration: 1
  })
  bench.add(observedBurstTask, async () => {
    const value = await implementation.runObservedCounterBurst(
      activeObservedRefs.get(implementation.implementation),
      configuration.burstBatchSize
    )
    if (value !== configuration.burstBatchSize) {
      throw new Error(
        `${implementation.label} observed runtime benchmark produced ${value}, expected ${configuration.burstBatchSize}`
      )
    }
  }, {
    beforeEach: async () => {
      activeObservedRefs.set(implementation.implementation, await implementation.startObservedCounter())
    },
    afterEach: async () => {
      const ref = activeObservedRefs.get(implementation.implementation)
      await implementation.stopObservedCounter(ref)
      activeObservedRefs.delete(implementation.implementation)
    }
  })

  const childBurstTask = `${implementation.implementation}:child-runtime-burst`
  benchmarkDefinitions.set(childBurstTask, {
    ...metadata,
    id: "child-runtime-burst",
    label: "Lookup and send to one child",
    unit: "increments/s",
    operationsPerIteration: configuration.childBatchSize,
    fenceEventsPerIteration: 1
  })
  const runChildBurst = implementation.async
    ? async () => {
      const value = await implementation.runChildCounterBurst(
        activeChildRefs.get(implementation.implementation),
        configuration.childBatchSize
      )
      if (value !== configuration.childBatchSize) {
        throw new Error(
          `${implementation.label} child runtime benchmark produced ${value}, expected ${configuration.childBatchSize}`
        )
      }
    }
    : () => {
      const value = implementation.runChildCounterBurst(
        activeChildRefs.get(implementation.implementation),
        configuration.childBatchSize
      )
      if (value !== configuration.childBatchSize) {
        throw new Error(
          `${implementation.label} child runtime benchmark produced ${value}, expected ${configuration.childBatchSize}`
        )
      }
    }
  bench.add(childBurstTask, runChildBurst, {
    beforeEach: async () => {
      activeChildRefs.set(implementation.implementation, await implementation.startChildCounter())
    },
    afterEach: async () => {
      const ref = activeChildRefs.get(implementation.implementation)
      await implementation.stopChildCounter(ref)
      activeChildRefs.delete(implementation.implementation)
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

  const childLifecycleTask = `${implementation.implementation}:child-start-stop`
  benchmarkDefinitions.set(childLifecycleTask, {
    ...metadata,
    id: "child-start-stop",
    label: "Start and stop a parent with one child",
    unit: "families/s",
    operationsPerIteration: 1
  })
  bench.add(
    childLifecycleTask,
    implementation.async
      ? async () => {
        await implementation.runChildLifecycle()
      }
      : () => implementation.runChildLifecycle()
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
    const childRef = activeChildRefs.get(implementation.implementation)
    if (childRef !== undefined) {
      await implementation.stopChildCounter(childRef)
      activeChildRefs.delete(implementation.implementation)
    }
    const observedRef = activeObservedRefs.get(implementation.implementation)
    if (observedRef !== undefined) {
      await implementation.stopObservedCounter(observedRef)
      activeObservedRefs.delete(implementation.implementation)
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
const memory = memoryImplementations.map((implementation) => {
  const profiles = Object.keys(implementation.memoryProfiles).map((profileId) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--expose-gc",
          memoryWorker,
          implementation.implementation,
          JSON.stringify(configuration.memoryCounts),
          profileId
        ],
        { encoding: "utf8" }
      )
    )
  )
  return { ...profiles[0], profiles }
})

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

  console.log("\nRuntime memory after forced GC\n")
  console.table(
    memory.flatMap((result) =>
      result.profiles.flatMap((profile) =>
        profile.points.map((point) => ({
          Implementation: `${result.implementationLabel} ${result.implementationVersion}`,
          Profile: profile.label,
          Units: integer.format(point.machines),
          "Heap delta": formatBytes(point.heapDeltaBytes),
          "Heap/unit": formatBytes(point.heapDeltaBytes / point.machines),
          "RSS delta": formatBytes(point.rssDeltaBytes)
        }))
      )
    )
  )
  for (const result of memory) {
    for (const profile of result.profiles) {
      console.log(
        `${result.implementationLabel} ${profile.label.toLowerCase()} heap slope: ${formatBytes(profile.heapBytesPerIdleMachine)} per unit`
      )
      if (profile.id === "idle" && Number.isFinite(profile.heapBytesPerIdleMachine) && profile.heapBytesPerIdleMachine > 0) {
        console.log(
          `${result.implementationLabel} estimated idle capacity per GiB: ${integer.format(1_073_741_824 / profile.heapBytesPerIdleMachine)} machines`
        )
      } else if (profile.id === "idle") {
        console.log(`${result.implementationLabel} estimated idle capacity per GiB: unavailable`)
      }
    }
  }
  console.log("RSS is an allocator-sensitive diagnostic; heap slope is the primary memory metric.")
  if (options.output !== undefined) {
    console.log(`\nJSON report written to ${options.output}`)
  }
  console.log("\nResults are informational. Compare runs made on the same machine and runtime configuration.")
}
