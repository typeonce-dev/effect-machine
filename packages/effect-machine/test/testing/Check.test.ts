import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Machine } from "../../src/index.js"
import { MachineTest } from "../../src/testing/index.js"

const laws = (report: { readonly findings: ReadonlyArray<{ readonly law: string }> }) =>
  report.findings.map((finding) => finding.law)

const Toggle = Machine.make({
  id: "Toggle",
  root: Machine.state({ states: { Off: {}, On: {} } }),
  events: Machine.events({ Flip: {} })
}).handle({
  initial: { target: "Off" },
  states: {
    Off: { on: { Flip: { target: "On" } } },
    On: { on: { Flip: { target: "Off" } } }
  }
})

const neverTaken = (): boolean => false

describe("MachineTest.analyze", () => {
  it("reports a state with no path and a public event with no handler", () => {
    const machine = Machine.make({
      root: Machine.state({ states: { Idle: {}, Orphan: { states: { Inner: {} } } } }),
      events: Machine.events({ Start: {}, Unused: {} })
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Start: { target: "Idle" } } },
        Orphan: { initial: { target: "Orphan.Inner" } }
      }
    })

    assert.deepStrictEqual(
      MachineTest.analyze(machine).map((finding) => ({
        law: finding.law,
        subject: finding.law === "events.noHandler" ? finding.event : finding.path,
        descendants: finding.law === "topology.noPathFromInitial" ? finding.descendants : undefined
      })),
      [
        { law: "events.noHandler", subject: "Unused", descendants: undefined },
        { law: "topology.noPathFromInitial", subject: "Orphan", descendants: 1 }
      ]
    )
  })

  it("follows initial children, parallel regions, choices, and invocation outcomes", () => {
    const machine = Machine.make({
      root: Machine.state({
        states: {
          Start: {},
          Pick: { type: "choice" },
          Left: {},
          Regions: {
            type: "parallel",
            states: {
              a: { states: { A1: {} } },
              b: { states: { B1: {} } }
            }
          },
          Waiting: {},
          Done: { type: "final" }
        }
      }),
      events: Machine.events({ Go: {}, Next: {} }),
      effects: { work: Effect.void }
    }).handle({
      initial: { target: "Start" },
      states: {
        Start: { on: { Go: { target: "Pick" } } },
        Pick: {
          choice: {
            branches: [{ target: "Left" }, { target: "Regions" }],
            resolve: ({ select }) => neverTaken() ? select.target("Regions") : select.target("Left")
          }
        },
        Left: { on: { Next: { target: "Waiting" } } },
        Regions: {
          states: {
            a: { initial: { target: "Regions.a.A1" } },
            b: { initial: { target: "Regions.b.B1" } }
          }
        },
        Waiting: { invoke: { src: "work", onDone: { target: "Done" } } }
      }
    })

    assert.deepStrictEqual(MachineTest.analyze(machine), [])
  })

  it("treats a branch target's descendants as reachable, because a resolver can construct them", () => {
    const machine = Machine.make({
      root: Machine.state({ states: { Idle: {}, Open: { states: { First: {}, Second: {} } } } }),
      events: Machine.events({ Go: {} })
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: {
          on: {
            Go: {
              branches: [{ target: "Open" }],
              resolve: ({ select }) => select.target("Open", { states: { Second: {} } })
            }
          }
        },
        Open: { initial: { target: "Open.First" } }
      }
    })

    assert.deepStrictEqual(MachineTest.analyze(machine), [])
  })

  it("does not run any callback", () => {
    let calls = 0
    const machine = Machine.make({
      root: Machine.state({ states: { A: {}, B: {} } }),
      events: Machine.events({ Go: {} })
    }).handle({
      initial: { target: "A" },
      states: {
        A: {
          on: {
            Go: {
              branches: [{ target: "B" }],
              resolve: ({ select }) => {
                calls += 1
                return select.target("B")
              }
            }
          }
        }
      }
    })

    MachineTest.analyze(machine)
    assert.strictEqual(calls, 0)
  })
})

describe("MachineTest.check", () => {
  it.effect("passes an exhaustively explored machine", () =>
    Effect.gen(function*() {
      const report = yield* MachineTest.check(Toggle)

      assert.deepStrictEqual(report, {
        machine: "Toggle",
        ok: true,
        exploration: "exhaustive",
        limits: [],
        stats: {
          states: 2,
          plannedTransitions: 2,
          transitions: { total: 2, hit: 2 },
          branches: { total: 2, hit: 2 }
        },
        findings: []
      })
    }))

  it.effect("reports sampled payloads and invocations as limits rather than as proof", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        root: Machine.state({ states: { Idle: {}, Busy: {} } }),
        events: Machine.events({ Add: { by: Schema.Number } }),
        effects: { work: Effect.void }
      }).handle({
        initial: { target: "Idle" },
        states: {
          Idle: { on: { Add: { target: "Busy" } } },
          Busy: { invoke: { src: "work", onDone: { target: "Idle" } } }
        }
      })

      const report = yield* MachineTest.check(machine)

      assert.isTrue(report.ok)
      assert.strictEqual(report.exploration, "bounded")
      assert.deepStrictEqual(report.limits, ["sampledEvents", "invocations"])
      assert.deepStrictEqual(laws(report), [])
    }))

  it.effect("does not warn about transitions only an unrun invocation can lead to", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        root: Machine.state({ states: { Idle: {}, Busy: {}, Failed: {} } }),
        events: Machine.events({ Start: {}, Retry: {} }),
        effects: { work: Effect.void }
      }).handle({
        initial: { target: "Idle" },
        states: {
          Idle: { on: { Start: { target: "Busy" } } },
          Busy: { invoke: { src: "work", onDone: { target: "Failed" } } },
          Failed: { on: { Retry: { target: "Busy" } } }
        }
      })

      const report = yield* MachineTest.check(machine)

      assert.deepStrictEqual(report.limits, ["invocations"])
      assert.deepStrictEqual(laws(report), [])
    }))

  it.effect("finds nondeterminism hidden behind a helper, with the events that reproduce it", () =>
    Effect.gen(function*() {
      const next = () => Math.random()
      const Events = Machine.events({ Pay: {} })
      const machine = Machine.make({
        root: Machine.state({
          states: { Editing: {}, Charging: { fields: { amount: Schema.Number } } }
        }),
        events: Events
      }).handle({
        initial: { target: "Editing" },
        states: {
          Editing: { on: { Pay: { target: "Charging", data: () => ({ amount: next() }) } } }
        }
      })

      const report = yield* MachineTest.check(machine)
      const finding = report.findings[0]!

      assert.isFalse(report.ok)
      assert.deepStrictEqual(laws(report), ["planning.deterministic"])
      assert.isTrue(finding.law === "planning.deterministic" && finding.replay.events.length === 1)
    }))

  it.effect("finds nondeterminism during startup", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        root: Machine.state({ states: { Idle: { fields: { at: Schema.Number } } } }),
        events: Machine.events({})
      }).handle({
        initial: { target: "Idle", data: () => ({ at: Math.random() }) }
      })

      const report = yield* MachineTest.check(machine)

      assert.deepStrictEqual(laws(report), ["planning.deterministic"])
    }))

  it.effect("reports a throwing callback instead of failing", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        root: Machine.state({ states: { Idle: {}, Done: {} } }),
        events: Machine.events({ Go: {} })
      }).handle({
        initial: { target: "Idle" },
        states: {
          Idle: {
            on: {
              Go: {
                target: "Done",
                guard: () => {
                  throw new Error("boom")
                }
              }
            }
          }
        }
      })

      const report = yield* MachineTest.check(machine)

      assert.isFalse(report.ok)
      assert.deepStrictEqual(laws(report), ["planning.failed"])
      assert.include(report.findings[0]!.message, "boom")
    }))

  it.effect("reports a declared branch that exploration never took as a warning", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        root: Machine.state({ states: { Idle: {}, Done: {}, Never: {} } }),
        events: Machine.events({ Go: {} })
      }).handle({
        initial: { target: "Idle" },
        states: {
          Idle: {
            on: {
              Go: {
                branches: [{ target: "Done" }, { target: "Never" }],
                resolve: ({ select }) => neverTaken() ? select.target("Never") : select.target("Done")
              }
            }
          }
        }
      })

      const report = yield* MachineTest.check(machine)

      assert.isTrue(report.ok)
      assert.deepStrictEqual(laws(report), ["transition.notCovered"])
    }))

  it.effect("reports an application invariant with the events that break it", () =>
    Effect.gen(function*() {
      const Root = Machine.state({ fields: { count: Schema.Number } })
      const Events = Machine.events({ Add: {} })
      const machine = Machine.make({ root: Root, events: Events }).handle({
        root: () => ({ count: 0 }),
        on: { Add: { update: { root: ({ root }) => ({ count: root.count + 1 }) } } }
      })

      const report = yield* MachineTest.check(machine, {
        invariants: [
          MachineTest.invariants(machine).state(
            "count stays below 2",
            ({ snapshot }) => Root.get(snapshot, "root" as never) !== undefined && snapshot.value.count < 2
          )
        ]
      })

      assert.isFalse(report.ok)
      const finding = report.findings[0]!
      assert.isTrue(finding.law === "invariant.violated" && finding.replay.events.length === 2)
    }))

  it.effect("stops at the limits and says so", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        root: Machine.state({ fields: { count: Schema.Number } }),
        events: Machine.events({ Add: {} })
      }).handle({
        root: () => ({ count: 0 }),
        on: { Add: { update: { root: ({ root }) => ({ count: root.count + 1 }) } } }
      })

      const report = yield* MachineTest.check(machine, { limits: { maxDepth: 3 } })

      assert.isTrue(report.ok)
      assert.strictEqual(report.exploration, "bounded")
      assert.deepStrictEqual(report.limits, ["depth"])
    }))

  it.effect("samples input from its schema, or uses the supplied input", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        root: Machine.state({ states: { Idle: { fields: { name: Schema.String } } } }),
        input: Schema.String,
        events: Machine.events({})
      }).handle({
        initial: { target: "Idle", data: ({ input }) => ({ name: input }) }
      })

      assert.deepStrictEqual((yield* MachineTest.check(machine)).limits, ["sampledInput"])
      assert.deepStrictEqual((yield* MachineTest.check(machine, { input: "a" })).limits, [])
    }))

  it.effect("does not send events to a completed machine", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        root: Machine.state({ states: { Idle: {}, Done: { type: "final" } } }),
        events: Machine.events({ Finish: {} })
      }).handle({
        initial: { target: "Idle" },
        states: {
          Idle: { on: { Finish: { target: "Done" } } }
        }
      })

      const report = yield* MachineTest.check(machine)

      assert.isTrue(report.ok)
      assert.strictEqual(report.stats.plannedTransitions, 1)
    }))

  it.effect("formats a report as text", () =>
    Effect.gen(function*() {
      assert.strictEqual(
        MachineTest.formatCheckReport(yield* MachineTest.check(Toggle)),
        "PASS Toggle: 2 states, 2/2 branches, exhaustive"
      )
    }))
})
