import { assert, describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { compiledHost, genericHost, plannedHost } from "../internal/machine/support/conformanceHosts.js"
import { differences } from "./differences.js"
import { children } from "./scenarios/children.js"
import { invocations } from "./scenarios/invocations.js"
import { restarts } from "./scenarios/restarts.js"
import { timers } from "./scenarios/timers.js"
import { transitions } from "./scenarios/transitions.js"
import type { Difference } from "./support/difference.js"
import { atomHost } from "./support/hosts/atom.js"
import { clusterHost } from "./support/hosts/cluster.js"
import { cellOf, check, checkEntry, renderMatrix } from "./support/suite.js"

const hosts = [genericHost, compiledHost, atomHost, clusterHost, plannedHost]
const scenarios = [...transitions, ...invocations, ...timers, ...restarts, ...children]

describe("conformance of hosts", () => {
  for (const host of hosts) {
    describe(host.name, () => {
      for (const scenario of scenarios) {
        const cell = cellOf(host, scenario, differences)
        if (cell._tag !== "Skipped") {
          it.effect(scenario.name, () => check(host, scenario, cell), 20_000)
        }
      }
    })
  }

  it("names every scenario once, and registers one difference at most for a host in it", () => {
    const names = scenarios.map(({ name }) => name)
    assert.deepStrictEqual(names, Array.from(new Set(names)))
    const cells = differences.flatMap(({ hosts, scenario }) => hosts.map((host) => `${host}: ${scenario}`))
    assert.deepStrictEqual(cells, Array.from(new Set(cells)))
  })

  for (const difference of differences) {
    it(`registers what exists for ${difference.hosts.join(", ")}: ${difference.scenario}`, () =>
      checkEntry(difference, hosts, scenarios, genericHost))
  }

  it.effect("refuses an entry for a host that does not differ, and an entry that says something else", () =>
    Effect.gen(function*() {
      const scenario = transitions.find(({ name }) => name === "moves between states and carries their data")!
      const entry: Difference = {
        kind: "Open",
        hosts: [genericHost.name],
        scenario: scenario.name,
        differs: "Nothing.",
        evidence: "None.",
        steps: { "send Close": { happens: [] } }
      }
      const agrees = yield* Effect.exit(check(genericHost, scenario, { _tag: "Differs", difference: entry }))
      assert.match(String(agrees), /no longer differs/)
      const changed = { ...scenario, steps: scenario.steps.slice(1) }
      const other = yield* Effect.exit(check(genericHost, changed, { _tag: "Differs", difference: entry }))
      assert.match(String(other), /to deeply equal/)
    }))

  // Adding a host or a scenario changes this table, and so does anything that
  // makes the suite run less. Update it with `vitest -u`, and read the change.
  it("runs this matrix", () =>
    expect(`${renderMatrix(hosts, scenarios, differences)}\n`).toMatchFileSnapshot("matrix.txt"))
})
