import { readFileSync } from "node:fs"

const [beforePath, afterPath] = process.argv.slice(2)

if (beforePath === undefined || afterPath === undefined) {
  throw new Error("Usage: node scripts/compare-type-performance.mjs <before.json> <after.json>")
}

const readReport = (path) => {
  const source = readFileSync(path, "utf8")
  if (Buffer.byteLength(source, "utf8") > 100_000) {
    throw new Error(`Type-performance report is too large: ${path}`)
  }

  const report = JSON.parse(source)
  if (report.schemaVersion !== 1 || !Array.isArray(report.scenarios)) {
    throw new Error(`Unsupported type-performance report: ${path}`)
  }

  if (
    typeof report.typescriptVersion !== "string" ||
    !/^[0-9A-Za-z.+-]{1,40}$/.test(report.typescriptVersion)
  ) {
    throw new Error(`Invalid TypeScript version in report: ${path}`)
  }
  if (report.scenarios.length > 100) {
    throw new Error(`Too many type-performance scenarios in report: ${path}`)
  }
  for (const scenario of report.scenarios) {
    if (
      typeof scenario.id !== "string" ||
      scenario.id.length > 100 ||
      typeof scenario.label !== "string" ||
      scenario.label.length > 200 ||
      !Number.isFinite(scenario.instantiations) ||
      scenario.instantiations < 0 ||
      (
        scenario.marginalInstantiations !== null &&
        !Number.isFinite(scenario.marginalInstantiations)
      ) ||
      !Number.isFinite(scenario.checkTimeSeconds) ||
      scenario.checkTimeSeconds < 0
    ) {
      throw new Error(`Invalid type-performance scenario in report: ${path}`)
    }
  }
  return report
}

const before = readReport(beforePath)
const after = readReport(afterPath)
const beforeScenarios = new Map(before.scenarios.map((scenario) => [scenario.id, scenario]))
const afterScenarios = new Map(after.scenarios.map((scenario) => [scenario.id, scenario]))
const scenarioIds = [
  ...after.scenarios.map((scenario) => scenario.id),
  ...before.scenarios
    .map((scenario) => scenario.id)
    .filter((id) => !afterScenarios.has(id))
]

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })
const seconds = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})

const formatInteger = (value) => value === undefined || value === null ? "—" : integer.format(value)

const formatDifference = (beforeValue, afterValue) => {
  if (beforeValue === undefined || beforeValue === null) {
    return afterValue === undefined || afterValue === null ? "—" : "new"
  }
  if (afterValue === undefined || afterValue === null) {
    return "removed"
  }

  const difference = afterValue - beforeValue
  const sign = difference > 0 ? "+" : ""
  const percentage = beforeValue === 0 ? undefined : difference / beforeValue * 100
  const percentageText = percentage === undefined
    ? ""
    : ` (${sign}${percentage.toFixed(1)}%)`
  return `${sign}${integer.format(difference)}${percentageText}`
}

const formatTime = (value) => value === undefined ? "—" : `${seconds.format(value)}s`
const markdownLabel = (scenario) => {
  if (scenario === undefined) {
    return "unknown"
  }
  return `\`${scenario.label.replaceAll("`", "\\`").replaceAll("|", "\\|")}\``
}

const lines = [
  "## Type performance",
  "",
  before.typescriptVersion === after.typescriptVersion
    ? `Measured with TypeScript ${after.typescriptVersion} and \`skipLibCheck=true\`.`
    : `Base uses TypeScript ${before.typescriptVersion}; PR uses TypeScript ${after.typescriptVersion}. Results include the compiler-version change.`,
  "",
  "| Scenario | Base | PR | Difference |",
  "| --- | ---: | ---: | ---: |"
]

for (const id of scenarioIds) {
  const beforeScenario = beforeScenarios.get(id)
  const afterScenario = afterScenarios.get(id)
  lines.push(
    `| ${markdownLabel(afterScenario ?? beforeScenario)} | ${formatInteger(beforeScenario?.instantiations)} | ${formatInteger(afterScenario?.instantiations)} | ${formatDifference(beforeScenario?.instantiations, afterScenario?.instantiations)} |`
  )
}

lines.push(
  "",
  "Marginal instantiations are measured against the matching setup without that API call:",
  "",
  "| Scenario | Base | PR | Difference |",
  "| --- | ---: | ---: | ---: |"
)

for (const id of scenarioIds) {
  const beforeScenario = beforeScenarios.get(id)
  const afterScenario = afterScenarios.get(id)
  if (
    beforeScenario?.marginalInstantiations === null &&
    afterScenario?.marginalInstantiations === null
  ) {
    continue
  }
  lines.push(
    `| ${markdownLabel(afterScenario ?? beforeScenario)} | ${formatInteger(beforeScenario?.marginalInstantiations)} | ${formatInteger(afterScenario?.marginalInstantiations)} | ${formatDifference(beforeScenario?.marginalInstantiations, afterScenario?.marginalInstantiations)} |`
  )
}

lines.push(
  "",
  "<details>",
  "<summary>Check times (informational)</summary>",
  "",
  "| Scenario | Base | PR |",
  "| --- | ---: | ---: |"
)

for (const id of scenarioIds) {
  const beforeScenario = beforeScenarios.get(id)
  const afterScenario = afterScenarios.get(id)
  lines.push(
    `| ${markdownLabel(afterScenario ?? beforeScenario)} | ${formatTime(beforeScenario?.checkTimeSeconds)} | ${formatTime(afterScenario?.checkTimeSeconds)} |`
  )
}

lines.push(
  "",
  "</details>",
  "",
  "Type instantiations are the comparison metric. Check time varies with runner load and is informational only."
)

console.log(lines.join("\n"))
