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

// Instantiation counts are deterministic for the pinned compiler. Budgets keep
// roughly thirty percent headroom; wall-clock check time is never gated.
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
    control: "import-only",
    maxInstantiations: 3_800,
    maxMarginalInstantiations: 3_700
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
    control: "make-control",
    maxInstantiations: 17_500,
    maxMarginalInstantiations: 13_500
  },
  {
    id: "handle",
    label: "machine.handle (3 states, 2 transitions)",
    file: "handle.ts",
    control: "make",
    maxInstantiations: 40_000,
    maxMarginalInstantiations: 23_000
  },
  {
    id: "dynamic-invoke-control",
    label: "dynamic Machine.invoke control",
    file: "dynamic-invoke-control.ts",
    hidden: true
  },
  {
    id: "dynamic-invoke",
    label: "Machine.invoke (state-dependent Effect)",
    file: "dynamic-invoke.ts",
    control: "dynamic-invoke-control",
    maxInstantiations: 85_000,
    maxMarginalInstantiations: 76_000
  },
  {
    id: "handle-depth-24-control",
    label: "machine.handle depth 24 control",
    file: "handle-depth-24-control.ts",
    hidden: true
  },
  {
    id: "handle-depth-24",
    label: "machine.handle (depth 24)",
    file: "handle-depth-24.ts",
    control: "handle-depth-24-control",
    maxInstantiations: 230_000,
    maxMarginalInstantiations: 215_000
  },
  {
    id: "handle-depth-wide-16-control",
    label: "machine.handle wide depth 16 control",
    file: "handle-depth-wide-16-control.ts",
    hidden: true
  },
  {
    id: "handle-depth-wide-16",
    label: "machine.handle (wide depth 16)",
    file: "handle-depth-wide-16.ts",
    control: "handle-depth-wide-16-control",
    maxInstantiations: 268_000,
    maxMarginalInstantiations: 255_000
  },
  {
    id: "composition-control",
    label: "parallel/history/choice control",
    file: "composition-control.ts",
    hidden: true
  },
  {
    id: "composition",
    label: "machine.handle (parallel/history/choice)",
    file: "composition.ts",
    control: "composition-control",
    maxInstantiations: 165_000,
    maxMarginalInstantiations: 142_000
  },
  {
    id: "successive-handle-control",
    label: "successive machine.handle control",
    file: "successive-handle-control.ts",
    hidden: true
  },
  {
    id: "successive-handle",
    label: "machine.handle (4 successive calls)",
    file: "successive-handle.ts",
    control: "successive-handle-control",
    maxInstantiations: 168_000,
    maxMarginalInstantiations: 147_000
  },
  {
    id: "exact-channels-control",
    label: "exact machine channels control",
    file: "exact-channels-control.ts",
    hidden: true
  },
  {
    id: "exact-channels",
    label: "machine exact input/output/error/services",
    file: "exact-channels.ts",
    control: "exact-channels-control",
    maxInstantiations: 143_000,
    maxMarginalInstantiations: 127_000
  },
  {
    id: "adapter-readiness-control",
    label: "adapter readiness control",
    file: "adapter-readiness-control.ts",
    hidden: true
  },
  {
    id: "adapter-readiness",
    label: "execution adapter readiness",
    file: "adapter-readiness.ts",
    control: "adapter-readiness-control",
    maxInstantiations: 158_000,
    maxMarginalInstantiations: 125_000
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

for (const scenario of visibleScenarios) {
  const result = results.get(scenario.id)
  const control = scenario.control === undefined ? undefined : results.get(scenario.control)
  const marginalInstantiations = control === undefined
    ? undefined
    : result.instantiations - control.instantiations

  if (
    scenario.maxInstantiations !== undefined &&
    result.instantiations > scenario.maxInstantiations
  ) {
    throw new Error(
      `Type-performance budget exceeded for ${scenario.id}: ` +
        `${result.instantiations} instantiations > ${scenario.maxInstantiations}`
    )
  }
  if (
    scenario.maxMarginalInstantiations !== undefined &&
    marginalInstantiations !== undefined &&
    marginalInstantiations > scenario.maxMarginalInstantiations
  ) {
    throw new Error(
      `Marginal type-performance budget exceeded for ${scenario.id}: ` +
        `${marginalInstantiations} instantiations > ${scenario.maxMarginalInstantiations}`
    )
  }
}

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
            maxInstantiations: scenario.maxInstantiations ?? null,
            maxMarginalInstantiations: scenario.maxMarginalInstantiations ?? null,
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
console.log("Configured total and marginal instantiation budgets are enforced before reporting.")
