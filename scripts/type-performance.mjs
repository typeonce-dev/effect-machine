import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

const options = {
  allowMissing: false,
  json: false,
  root: resolve(import.meta.dirname, "..")
}

for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index]

  if (argument === "--allow-missing") {
    options.allowMissing = true
  } else if (argument === "--json") {
    options.json = true
  } else if (argument === "--root") {
    const root = process.argv[index + 1]
    if (root === undefined) {
      throw new Error("--root requires a directory")
    }
    options.root = resolve(root)
    index += 1
  } else {
    throw new Error(`Unknown argument: ${argument}`)
  }
}

const root = options.root
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
  const file = resolve(root, "perf", "types", scenario.file)
  if (!existsSync(file)) {
    if (options.allowMissing) {
      continue
    }
    throw new Error(`Type-performance scenario does not exist: ${file}`)
  }

  const output = run([...compilerArguments, file])

  results.set(scenario.id, {
    instantiations: readMetric(output, "Instantiations"),
    checkTime: readMetric(output, "Check time")
  })
}

const visibleScenarios = scenarios.filter(
  (scenario) => scenario.hidden !== true && results.has(scenario.id)
)
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

if (options.json) {
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        typescriptVersion: version,
        skipLibCheck: true,
        scenarios: visibleScenarios.map((scenario) => {
          const result = results.get(scenario.id)
          const control = scenario.control === undefined ? undefined : results.get(scenario.control)

          return {
            id: scenario.id,
            label: scenario.label,
            instantiations: result.instantiations,
            marginalInstantiations:
              control === undefined ? null : result.instantiations - control.instantiations,
            checkTimeSeconds: result.checkTime
          }
        })
      },
      null,
      2
    )
  )
  process.exit(0)
}

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
