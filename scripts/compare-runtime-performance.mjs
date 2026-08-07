import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const [baseDirectory, pullRequestDirectory] = process.argv.slice(2)

if (baseDirectory === undefined || pullRequestDirectory === undefined) {
  throw new Error(
    "Usage: node scripts/compare-runtime-performance.mjs <base-report-directory> <pr-report-directory>"
  )
}

const isBoundedNumber = (value) => Number.isFinite(value) && Math.abs(value) <= 1_000_000_000_000_000
const isShortString = (value, maximum) => typeof value === "string" && value.length > 0 && value.length <= maximum

const validateReport = (report, path) => {
  if (
    report?.schemaVersion !== 2 ||
    typeof report.environment !== "object" ||
    report.environment === null ||
    typeof report.configuration !== "object" ||
    report.configuration === null ||
    !Array.isArray(report.benchmarks) ||
    !Array.isArray(report.memory)
  ) {
    throw new Error(`Unsupported runtime-performance report: ${path}`)
  }
  if (
    !isShortString(report.environment.node, 40) ||
    !isShortString(report.environment.architecture, 40) ||
    !isShortString(report.environment.cpu, 200) ||
    report.benchmarks.length > 100 ||
    report.memory.length > 20
  ) {
    throw new Error(`Invalid runtime-performance metadata: ${path}`)
  }

  const benchmarkKeys = new Set()
  for (const benchmark of report.benchmarks) {
    const key = `${benchmark.implementation}\u0000${benchmark.id}`
    if (
      !isShortString(benchmark.implementation, 100) ||
      !isShortString(benchmark.implementationLabel, 200) ||
      !isShortString(benchmark.implementationVersion, 100) ||
      !isShortString(benchmark.id, 100) ||
      !isShortString(benchmark.label, 200) ||
      !isShortString(benchmark.unit, 100) ||
      !isBoundedNumber(benchmark.medianThroughput) ||
      benchmark.medianThroughput < 0 ||
      !isBoundedNumber(benchmark.relativeMarginOfError) ||
      benchmark.relativeMarginOfError < 0 ||
      benchmarkKeys.has(key)
    ) {
      throw new Error(`Invalid runtime-performance benchmark: ${path}`)
    }
    benchmarkKeys.add(key)
  }

  const memoryKeys = new Set()
  for (const measurement of report.memory) {
    if (
      !isShortString(measurement.implementation, 100) ||
      !isShortString(measurement.implementationLabel, 200) ||
      !isShortString(measurement.implementationVersion, 100) ||
      !isBoundedNumber(measurement.heapBytesPerIdleMachine) ||
      measurement.heapBytesPerIdleMachine < 0 ||
      !Array.isArray(measurement.points) ||
      measurement.points.length > 20 ||
      memoryKeys.has(measurement.implementation)
    ) {
      throw new Error(`Invalid runtime-performance memory measurement: ${path}`)
    }
    for (const point of measurement.points) {
      if (
        !Number.isSafeInteger(point.machines) ||
        point.machines < 0 ||
        !isBoundedNumber(point.heapDeltaBytes) ||
        !isBoundedNumber(point.rssDeltaBytes)
      ) {
        throw new Error(`Invalid runtime-performance memory point: ${path}`)
      }
    }
    memoryKeys.add(measurement.implementation)
  }
}

const readReports = (directory, required) => {
  if (!existsSync(directory)) {
    if (required) {
      throw new Error(`Runtime-performance report directory does not exist: ${directory}`)
    }
    return []
  }

  const entries = readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .sort()
  if (entries.length === 0) {
    if (required) {
      throw new Error(`Runtime-performance report directory is empty: ${directory}`)
    }
    return []
  }
  if (entries.length > 5) {
    throw new Error(`Too many runtime-performance reports in ${directory}`)
  }

  return entries.map((entry) => {
    const path = join(directory, entry)
    if (!statSync(path).isFile() || statSync(path).size > 500_000) {
      throw new Error(`Invalid runtime-performance report file: ${path}`)
    }
    const report = JSON.parse(readFileSync(path, "utf8"))
    validateReport(report, path)
    return report
  })
}

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

const assertConsistentRuns = (reports, label) => {
  const first = reports[0]
  const configuration = JSON.stringify(first.configuration)
  const benchmarkKeys = first.benchmarks.map((benchmark) =>
    `${benchmark.implementation}\u0000${benchmark.id}\u0000${benchmark.unit}`
  ).sort().join("\u0001")
  const memoryKeys = first.memory.map((measurement) => measurement.implementation).sort().join("\u0001")

  for (const report of reports.slice(1)) {
    if (
      JSON.stringify(report.configuration) !== configuration ||
      report.environment.node !== first.environment.node ||
      report.environment.architecture !== first.environment.architecture ||
      report.environment.cpu !== first.environment.cpu ||
      report.benchmarks.map((benchmark) =>
        `${benchmark.implementation}\u0000${benchmark.id}\u0000${benchmark.unit}`
      ).sort().join("\u0001") !== benchmarkKeys ||
      report.memory.map((measurement) => measurement.implementation).sort().join("\u0001") !== memoryKeys
    ) {
      throw new Error(`Inconsistent ${label} runtime-performance reports`)
    }
  }
}

const aggregate = (reports, label) => {
  assertConsistentRuns(reports, label)
  const first = reports[0]
  return {
    runCount: reports.length,
    environment: first.environment,
    configuration: first.configuration,
    benchmarks: first.benchmarks.map((benchmark) => {
      const matches = reports.map((report) =>
        report.benchmarks.find((candidate) =>
          candidate.implementation === benchmark.implementation && candidate.id === benchmark.id
        )
      )
      return {
        ...benchmark,
        medianThroughput: median(matches.map((match) => match.medianThroughput)),
        relativeMarginOfError: median(matches.map((match) => match.relativeMarginOfError))
      }
    }),
    memory: first.memory.map((measurement) => ({
      ...measurement,
      heapBytesPerIdleMachine: median(
        reports.map((report) =>
          report.memory.find((candidate) => candidate.implementation === measurement.implementation)
            .heapBytesPerIdleMachine
        )
      )
    }))
  }
}

const baseReports = readReports(baseDirectory, false)
const pullRequestReports = readReports(pullRequestDirectory, true)
const base = baseReports.length === 0 ? undefined : aggregate(baseReports, "base")
const pullRequest = aggregate(pullRequestReports, "pull request")

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })
const decimal = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const escapeCell = (value) => String(value).replaceAll("|", "\\|").replaceAll("\n", " ")
const code = (value) => `\`${String(value).replaceAll("`", "\\`")}\``
const formatThroughput = (value, unit) => `${integer.format(value)} ${escapeCell(unit)}`
const formatHeap = (value) => `${decimal.format(value / 1_024)} KiB`
const formatDifference = (before, after) => {
  const difference = after - before
  const sign = difference > 0 ? "+" : ""
  const percentage = before === 0 ? undefined : difference / before * 100
  return percentage === undefined
    ? `${sign}${integer.format(difference)}`
    : `${sign}${decimal.format(percentage)}%`
}

const implementations = [...new Map(
  pullRequest.benchmarks.map((benchmark) => [benchmark.implementation, {
    id: benchmark.implementation,
    label: benchmark.implementationLabel,
    version: benchmark.implementationVersion
  }])
).values()]
const scenarios = [...new Map(
  pullRequest.benchmarks.map((benchmark) => [benchmark.id, {
    id: benchmark.id,
    label: benchmark.label,
    unit: benchmark.unit
  }])
).values()]

const lines = [
  "## Runtime performance",
  "",
  `Median of ${pullRequest.runCount} independent benchmark processes on ${code(pullRequest.environment.cpu)} with Node ${code(pullRequest.environment.node)}.`,
  "",
  "### Pull request baseline",
  "",
  `| Scenario | ${implementations.map((implementation) => escapeCell(implementation.label)).join(" | ")} |`,
  `| --- | ${implementations.map(() => "---:").join(" | ")} |`
]

for (const scenario of scenarios) {
  lines.push(
    `| ${escapeCell(scenario.label)} | ${implementations.map((implementation) => {
      const benchmark = pullRequest.benchmarks.find((candidate) =>
        candidate.implementation === implementation.id && candidate.id === scenario.id
      )
      return benchmark === undefined ? "—" : formatThroughput(benchmark.medianThroughput, benchmark.unit)
    }).join(" | ")} |`
  )
}

lines.push(
  "",
  "| Idle memory | Heap per machine |",
  "| --- | ---: |"
)
for (const implementation of implementations) {
  const measurement = pullRequest.memory.find((candidate) => candidate.implementation === implementation.id)
  lines.push(
    `| ${escapeCell(implementation.label)} | ${measurement === undefined ? "—" : formatHeap(measurement.heapBytesPerIdleMachine)} |`
  )
}

if (base === undefined) {
  lines.push(
    "",
    "The base revision does not contain the runtime benchmark harness, so this bootstrapping PR reports the pull request baseline without a base comparison."
  )
} else if (JSON.stringify(base.configuration) !== JSON.stringify(pullRequest.configuration)) {
  lines.push(
    "",
    "Base and pull request use different benchmark configurations, so their results are not compared."
  )
} else {
  const baseEffect = new Map(
    base.benchmarks
      .filter((benchmark) => benchmark.implementation === "effect-machine")
      .map((benchmark) => [benchmark.id, benchmark])
  )
  const pullRequestEffect = new Map(
    pullRequest.benchmarks
      .filter((benchmark) => benchmark.implementation === "effect-machine")
      .map((benchmark) => [benchmark.id, benchmark])
  )
  lines.push(
    "",
    "### Effect Machine change from base",
    "",
    "| Metric | Base | PR | Difference |",
    "| --- | ---: | ---: | ---: |"
  )
  for (const scenario of scenarios) {
    const before = baseEffect.get(scenario.id)
    const after = pullRequestEffect.get(scenario.id)
    if (before !== undefined && after !== undefined && before.unit === after.unit) {
      lines.push(
        `| ${escapeCell(scenario.label)} | ${formatThroughput(before.medianThroughput, before.unit)} | ${formatThroughput(after.medianThroughput, after.unit)} | ${formatDifference(before.medianThroughput, after.medianThroughput)} |`
      )
    }
  }
  const beforeMemory = base.memory.find((measurement) => measurement.implementation === "effect-machine")
  const afterMemory = pullRequest.memory.find((measurement) => measurement.implementation === "effect-machine")
  if (beforeMemory !== undefined && afterMemory !== undefined) {
    lines.push(
      `| Idle heap per machine | ${formatHeap(beforeMemory.heapBytesPerIdleMachine)} | ${formatHeap(afterMemory.heapBytesPerIdleMachine)} | ${formatDifference(beforeMemory.heapBytesPerIdleMachine, afterMemory.heapBytesPerIdleMachine)} |`
    )
  }
}

lines.push(
  "",
  "<details>",
  "<summary>Versions and interpretation</summary>",
  "",
  ...implementations.map((implementation) =>
    `- ${escapeCell(implementation.label)}: ${code(implementation.version)}`
  ),
  "",
  "Higher throughput is better; lower idle heap is better. Runtime measurements on shared GitHub-hosted hardware remain informational, so small differences should be confirmed across multiple workflow runs.",
  "",
  "</details>"
)

console.log(lines.join("\n"))
