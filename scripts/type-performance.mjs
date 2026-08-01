import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const tsc = resolve(root, "node_modules", "typescript", "bin", "tsc")

const scenarios = [
  {
    id: "effect-only",
    label: "Effect only",
    file: "effect-only.ts"
  },
  {
    id: "import-only",
    label: "Import effect-machine",
    file: "import-only.ts",
    control: "effect-only"
  },
  {
    id: "define-states",
    label: "Machine.defineStates (3 states)",
    file: "define-states.ts",
    control: "import-only"
  },
  {
    id: "make-control",
    label: "Machine.make setup",
    file: "make-control.ts",
    hidden: true
  },
  {
    id: "make",
    label: "Machine.make (3 states, 2 events)",
    file: "make.ts",
    control: "make-control"
  },
  {
    id: "handle",
    label: "machine.handle (3 states, 2 transitions)",
    file: "handle.ts",
    control: "make"
  }
]

const compilerArguments = [
  "--ignoreConfig",
  "--noEmit",
  "--incremental",
  "false",
  "--strict",
  "--skipLibCheck",
  "true",
  "--target",
  "ES2022",
  "--module",
  "NodeNext",
  "--moduleResolution",
  "NodeNext",
  "--verbatimModuleSyntax",
  "true",
  "--exactOptionalPropertyTypes",
  "true",
  "--lib",
  "ES2022",
  "--pretty",
  "false",
  "--extendedDiagnostics"
]

const run = (args) => {
  const result = spawnSync(process.execPath, [tsc, ...args], {
    cwd: root,
    encoding: "utf8"
  })

  if (result.status !== 0) {
    throw new Error([result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join("\n"))
  }

  return result.stdout
}

const readMetric = (output, name) => {
  const match = output.match(new RegExp(`^${name}:\\s+([0-9.]+)`, "m"))
  if (match === null) {
    throw new Error(`TypeScript did not report the ${name} metric`)
  }
  return Number(match[1])
}

const version = run(["--version"])
  .trim()
  .replace(/^Version\s+/, "")
const results = new Map()

for (const scenario of scenarios) {
  const output = run([...compilerArguments, resolve(root, "perf", "types", scenario.file)])

  results.set(scenario.id, {
    instantiations: readMetric(output, "Instantiations"),
    checkTime: readMetric(output, "Check time")
  })
}

const visibleScenarios = scenarios.filter((scenario) => scenario.hidden !== true)
const rows = visibleScenarios.map((scenario) => {
  const result = results.get(scenario.id)
  const control = scenario.control === undefined ? undefined : results.get(scenario.control)
  const delta = control === undefined ? undefined : result.instantiations - control.instantiations

  return {
    scenario: scenario.label,
    instantiations: result.instantiations.toLocaleString("en-US"),
    delta: delta === undefined ? "baseline" : `${delta >= 0 ? "+" : ""}${delta.toLocaleString("en-US")}`,
    checkTime: `${result.checkTime.toFixed(2)}s`
  }
})

const widths = {
  scenario: Math.max("Scenario".length, ...rows.map((row) => row.scenario.length)),
  instantiations: Math.max("Instantiations".length, ...rows.map((row) => row.instantiations.length)),
  delta: Math.max("Marginal".length, ...rows.map((row) => row.delta.length)),
  checkTime: Math.max("Check time".length, ...rows.map((row) => row.checkTime.length))
}

const formatRow = (row) =>
  [
    row.scenario.padEnd(widths.scenario),
    row.instantiations.padStart(widths.instantiations),
    row.delta.padStart(widths.delta),
    row.checkTime.padStart(widths.checkTime)
  ].join("  ")

console.log(`Type performance (TypeScript ${version}, skipLibCheck=true)\n`)
console.log(
  formatRow({
    scenario: "Scenario",
    instantiations: "Instantiations",
    delta: "Marginal",
    checkTime: "Check time"
  })
)
console.log(
  formatRow({
    scenario: "-".repeat(widths.scenario),
    instantiations: "-".repeat(widths.instantiations),
    delta: "-".repeat(widths.delta),
    checkTime: "-".repeat(widths.checkTime)
  })
)
for (const row of rows) {
  console.log(formatRow(row))
}

console.log("\nMarginal is measured against the matching setup without that API call.")
console.log("Check time is informational; instantiations are the stable comparison metric.")
