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
      (benchmark.group !== undefined && benchmark.group !== "machine" && benchmark.group !== "effect-runtime") ||
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
    if (measurement.profiles !== undefined) {
      if (!Array.isArray(measurement.profiles) || measurement.profiles.length === 0 || measurement.profiles.length > 10) {
        throw new Error(`Invalid runtime-performance memory profiles: ${path}`)
      }
      const profileIds = new Set()
      for (const profile of measurement.profiles) {
        if (
          profile.implementation !== measurement.implementation ||
          !isShortString(profile.id, 100) ||
          !isShortString(profile.label, 200) ||
          !isBoundedNumber(profile.heapBytesPerIdleMachine) ||
          profile.heapBytesPerIdleMachine < 0 ||
          !Array.isArray(profile.points) ||
          profile.points.length > 20 ||
          profileIds.has(profile.id)
        ) {
          throw new Error(`Invalid runtime-performance memory profile: ${path}`)
        }
        for (const point of profile.points) {
          if (
            !Number.isSafeInteger(point.machines) ||
            point.machines < 0 ||
            !isBoundedNumber(point.heapDeltaBytes) ||
            !isBoundedNumber(point.rssDeltaBytes)
          ) {
            throw new Error(`Invalid runtime-performance memory profile point: ${path}`)
          }
        }
        profileIds.add(profile.id)
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

const relativeMedianAbsoluteDeviation = (values) => {
  const center = median(values)
  return center === 0 ? 0 : median(values.map((value) => Math.abs(value - center))) / center * 100
}

const assertConsistentRuns = (reports, label) => {
  const first = reports[0]
  const configuration = JSON.stringify(first.configuration)
  const benchmarkKeys = first.benchmarks.map((benchmark) =>
    `${benchmark.implementation}\u0000${benchmark.id}\u0000${benchmark.unit}`
  ).sort().join("\u0001")
  const memoryKeys = first.memory.map((measurement) => measurement.implementation).sort().join("\u0001")
  const memoryProfileKeys = first.memory.flatMap((measurement) =>
    (measurement.profiles ?? []).map((profile) => `${measurement.implementation}\u0000${profile.id}`)
  ).sort().join("\u0001")

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
      || report.memory.flatMap((measurement) =>
        (measurement.profiles ?? []).map((profile) => `${measurement.implementation}\u0000${profile.id}`)
      ).sort().join("\u0001") !== memoryProfileKeys
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
      const throughputs = matches.map((match) => match.medianThroughput)
      return {
        ...benchmark,
        medianThroughput: median(throughputs),
        processRelativeMad: relativeMedianAbsoluteDeviation(throughputs),
        relativeMarginOfError: median(matches.map((match) => match.relativeMarginOfError))
      }
    }),
    memory: first.memory.map((measurement) => {
      const matches = reports.map((report) =>
        report.memory.find((candidate) => candidate.implementation === measurement.implementation)
      )
      const heapSlopes = matches.map((match) => match.heapBytesPerIdleMachine)
      return {
        ...measurement,
        heapBytesPerIdleMachine: median(heapSlopes),
        processRelativeMad: relativeMedianAbsoluteDeviation(heapSlopes),
        profiles: measurement.profiles?.map((profile) => {
          const profileMatches = matches.map((match) =>
            match.profiles.find((candidate) => candidate.id === profile.id)
          )
          const profileHeapSlopes = profileMatches.map((match) => match.heapBytesPerIdleMachine)
          return {
            ...profile,
            heapBytesPerIdleMachine: median(profileHeapSlopes),
            processRelativeMad: relativeMedianAbsoluteDeviation(profileHeapSlopes)
          }
        })
      }
    })
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
const formatVariability = (value) => `${decimal.format(value)}% MAD`
const formatDifference = (before, after) => {
  const difference = after - before
  const sign = difference > 0 ? "+" : ""
  const percentage = before === 0 ? undefined : difference / before * 100
  return percentage === undefined
    ? `${sign}${integer.format(difference)}`
    : `${sign}${decimal.format(percentage)}%`
}

const machineBenchmarks = pullRequest.benchmarks.filter((benchmark) => benchmark.group !== "effect-runtime")
const runtimeBenchmarks = pullRequest.benchmarks.filter((benchmark) => benchmark.group === "effect-runtime")
const benchmarkImplementations = [...new Map(
  machineBenchmarks.map((benchmark) => [benchmark.implementation, {
    id: benchmark.implementation,
    label: benchmark.implementationLabel,
    version: benchmark.implementationVersion
  }])
).values()]
const runtimeImplementations = [...new Map(
  runtimeBenchmarks.map((benchmark) => [benchmark.implementation, {
    id: benchmark.implementation,
    label: benchmark.implementationLabel,
    version: benchmark.implementationVersion
  }])
).values()]
const memoryImplementations = pullRequest.memory.map((measurement) => ({
  id: measurement.implementation,
  label: measurement.implementationLabel,
  version: measurement.implementationVersion
}))
const reportedImplementations = [...new Map(
  [...benchmarkImplementations, ...runtimeImplementations, ...memoryImplementations].map((implementation) => [
    implementation.id,
    implementation
  ])
).values()]
const machineScenarios = [...new Map(
  machineBenchmarks.map((benchmark) => [benchmark.id, {
    id: benchmark.id,
    label: benchmark.label,
    unit: benchmark.unit
  }])
).values()]
const runtimeScenarios = [...new Map(
  runtimeBenchmarks.map((benchmark) => [benchmark.id, {
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
  `| Scenario | ${benchmarkImplementations.map((implementation) => escapeCell(implementation.label)).join(" | ")} |`,
  `| --- | ${benchmarkImplementations.map(() => "---:").join(" | ")} |`
]

for (const scenario of machineScenarios) {
  lines.push(
    `| ${escapeCell(scenario.label)} | ${benchmarkImplementations.map((implementation) => {
      const benchmark = pullRequest.benchmarks.find((candidate) =>
        candidate.implementation === implementation.id && candidate.id === scenario.id
      )
      return benchmark === undefined ? "—" : formatThroughput(benchmark.medianThroughput, benchmark.unit)
    }).join(" | ")} |`
  )
}

if (runtimeScenarios.length > 0) {
  lines.push(
    "",
    "### Effect runtime reference points",
    "",
    `| Scenario | ${runtimeImplementations.map((implementation) => escapeCell(implementation.label)).join(" | ")} |`,
    `| --- | ${runtimeImplementations.map(() => "---:").join(" | ")} |`
  )
  for (const scenario of runtimeScenarios) {
    lines.push(
      `| ${escapeCell(scenario.label)} | ${runtimeImplementations.map((implementation) => {
        const benchmark = runtimeBenchmarks.find((candidate) =>
          candidate.implementation === implementation.id && candidate.id === scenario.id
        )
        return benchmark === undefined ? "—" : formatThroughput(benchmark.medianThroughput, benchmark.unit)
      }).join(" | ")} |`
    )
  }
}

const memoryProfiles = [...new Map(
  pullRequest.memory.flatMap((measurement) =>
    (measurement.profiles ?? []).map((profile) => [profile.id, { id: profile.id, label: profile.label }])
  )
).values()]
lines.push(
  "",
  `| Memory profile | ${memoryImplementations.map((implementation) => escapeCell(implementation.label)).join(" | ")} |`,
  `| --- | ${memoryImplementations.map(() => "---:").join(" | ")} |`
)
for (const profile of memoryProfiles) {
  lines.push(
    `| ${escapeCell(profile.label)} | ${memoryImplementations.map((implementation) => {
      const measurement = pullRequest.memory.find((candidate) => candidate.implementation === implementation.id)
      const implementationProfile = measurement?.profiles?.find((candidate) => candidate.id === profile.id)
      return implementationProfile === undefined ? "—" : formatHeap(implementationProfile.heapBytesPerIdleMachine)
    }).join(" | ")} |`
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
    "| Metric | Base | Base variability | PR | PR variability | Difference |",
    "| --- | ---: | ---: | ---: | ---: | ---: |"
  )
  for (const scenario of machineScenarios) {
    const before = baseEffect.get(scenario.id)
    const after = pullRequestEffect.get(scenario.id)
    if (before !== undefined && after !== undefined && before.unit === after.unit) {
      lines.push(
        `| ${escapeCell(scenario.label)} | ${formatThroughput(before.medianThroughput, before.unit)} | ${formatVariability(before.processRelativeMad)} | ${formatThroughput(after.medianThroughput, after.unit)} | ${formatVariability(after.processRelativeMad)} | ${formatDifference(before.medianThroughput, after.medianThroughput)} |`
      )
    }
  }
  const beforeMemory = base.memory.find((measurement) => measurement.implementation === "effect-machine")
  const afterMemory = pullRequest.memory.find((measurement) => measurement.implementation === "effect-machine")
  if (beforeMemory !== undefined && afterMemory !== undefined) {
    for (const beforeProfile of beforeMemory.profiles ?? []) {
      const afterProfile = afterMemory.profiles?.find((candidate) => candidate.id === beforeProfile.id)
      if (afterProfile !== undefined) {
        lines.push(
          `| ${escapeCell(beforeProfile.label)} heap per unit | ${formatHeap(beforeProfile.heapBytesPerIdleMachine)} | ${formatVariability(beforeProfile.processRelativeMad)} | ${formatHeap(afterProfile.heapBytesPerIdleMachine)} | ${formatVariability(afterProfile.processRelativeMad)} | ${formatDifference(beforeProfile.heapBytesPerIdleMachine, afterProfile.heapBytesPerIdleMachine)} |`
        )
      }
    }
  }
  const baseRuntime = new Map(
    base.benchmarks
      .filter((benchmark) => benchmark.group === "effect-runtime")
      .map((benchmark) => [benchmark.id, benchmark])
  )
  const pullRequestRuntime = new Map(
    pullRequest.benchmarks
      .filter((benchmark) => benchmark.group === "effect-runtime")
      .map((benchmark) => [benchmark.id, benchmark])
  )
  if (baseRuntime.size > 0 && pullRequestRuntime.size > 0) {
    lines.push(
      "",
      "### Effect runtime reference change from base",
      "",
      "| Metric | Base | Base variability | PR | PR variability | Difference |",
      "| --- | ---: | ---: | ---: | ---: | ---: |"
    )
    for (const scenario of runtimeScenarios) {
      const before = baseRuntime.get(scenario.id)
      const after = pullRequestRuntime.get(scenario.id)
      if (before !== undefined && after !== undefined && before.unit === after.unit) {
        lines.push(
          `| ${escapeCell(scenario.label)} | ${formatThroughput(before.medianThroughput, before.unit)} | ${formatVariability(before.processRelativeMad)} | ${formatThroughput(after.medianThroughput, after.unit)} | ${formatVariability(after.processRelativeMad)} | ${formatDifference(before.medianThroughput, after.medianThroughput)} |`
        )
      }
    }
  }
}

lines.push(
  "",
  "<details>",
  "<summary>Versions and interpretation</summary>",
  "",
  ...reportedImplementations.map((implementation) =>
    `- ${escapeCell(implementation.label)}: ${code(implementation.version)}`
  ),
  "",
  "Higher throughput is better; lower heap is better. Variability is the median absolute deviation across independent processes, relative to their median. Runtime measurements on shared GitHub-hosted hardware remain informational, so small differences should be confirmed across multiple workflow runs.",
  "",
  "</details>"
)

console.log(lines.join("\n"))
