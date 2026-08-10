import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { FastCheck } from "effect/testing"
import { Machine } from "../../src/index.js"
import { MachineTest } from "../../src/testing/index.js"

const event = (_tag: string): { readonly _tag: string } => ({ _tag })

const fields = (error: MachineTest.ModelVerificationError): ReadonlyArray<string> =>
  error.mismatches.map((mismatch) => mismatch.field)

const snapshotAtPath = (snapshot: unknown, path: string): unknown => {
  if (typeof snapshot !== "object" || snapshot === null) return undefined
  const current = snapshot as Record<string, unknown>
  if (current.path === path) return snapshot
  if (current.state !== undefined) {
    const found = snapshotAtPath(current.state, path)
    if (found !== undefined) return found
  }
  if (typeof current.states === "object" && current.states !== null) {
    for (const child of Object.values(current.states)) {
      const found = snapshotAtPath(child, path)
      if (found !== undefined) return found
    }
  }
  return undefined
}

describe("MachineTest finite-model reference interpreter", () => {
  it.effect("stabilizes acyclic always and completion transitions in semantic order", () =>
    Effect.gen(function*() {
      const model: MachineTest.FiniteModel = {
        roots: [{
          _tag: "Compound",
          key: "flow",
          value: 0,
          initial: "idle",
          states: [
            { _tag: "Atomic", key: "idle", value: 1 },
            {
              _tag: "Compound",
              key: "work",
              value: 2,
              initial: "finished",
              states: [{ _tag: "Final", key: "finished", value: 3, output: "work:finished" }]
            },
            { _tag: "Atomic", key: "archived", value: 4 }
          ]
        }],
        initial: "flow",
        events: ["Tick"],
        transitions: [
          { source: "flow.idle", trigger: { type: "always" }, target: "flow.work" },
          // Completion has priority over an `always` transition registered on
          // the same newly completed state.
          { source: "flow.work", trigger: { type: "always" }, target: "flow.idle" },
          { source: "flow.work", trigger: { type: "done" }, target: "flow.archived" }
        ]
      }

      const reference = MachineTest.interpretModel(model, [])
      assert.deepStrictEqual(
        reference.initial.microsteps.flatMap((microstep) => microstep.transitions.map(({ trigger }) => trigger)),
        [{ type: "always" }, { type: "done" }]
      )
      assert.deepStrictEqual(reference.initial.state.activePaths, ["flow", "flow.archived"])

      const machine = MachineTest.compileModel(model)
      const trace = yield* MachineTest.run(machine, { events: [] })
      yield* MachineTest.verifyModel(model, trace)
    }))

  it.effect("stabilizes event transitions through always transitions", () =>
    Effect.gen(function*() {
      const model: MachineTest.FiniteModel = {
        roots: [
          { _tag: "Atomic", key: "idle", value: 0 },
          { _tag: "Atomic", key: "working", value: 1 },
          { _tag: "Atomic", key: "ready", value: 2 }
        ],
        initial: "idle",
        events: ["Start"],
        transitions: [
          { source: "idle", trigger: { type: "event", event: "Start" }, target: "working", reenter: false },
          { source: "working", trigger: { type: "always" }, target: "ready" }
        ]
      }
      const reference = MachineTest.interpretModel(model, ["Start"])
      assert.deepStrictEqual(
        reference.steps[0]?.microsteps.flatMap((microstep) => microstep.transitions.map(({ trigger }) => trigger)),
        [{ type: "event", event: "Start" }, { type: "always" }]
      )
      assert.deepStrictEqual(reference.final.activePaths, ["ready"])

      const machine = MachineTest.compileModel(model)
      const trace = yield* MachineTest.run(machine, { events: [event("Start")] })
      yield* MachineTest.verifyModel(model, trace)
    }))

  it.effect("recognizes completion again after exiting and reentering the same completed path", () =>
    Effect.gen(function*() {
      const model: MachineTest.FiniteModel = {
        roots: [{
          _tag: "Compound",
          key: "root",
          value: 0,
          initial: "job",
          states: [{
            _tag: "Compound",
            key: "job",
            value: 1,
            initial: "done",
            states: [{ _tag: "Final", key: "done", value: 2, output: "job:done" }]
          }]
        }],
        initial: "root",
        events: ["Reset"],
        transitions: [
          // This targetless completion consumes the completion generation
          // without changing the retained completion metadata.
          { source: "root.job", trigger: { type: "done" } },
          { source: "root.job", trigger: { type: "event", event: "Reset" }, target: "root.job", reenter: true }
        ]
      }

      const reference = MachineTest.interpretModel(model, ["Reset"])
      assert.deepStrictEqual(
        reference.initial.microsteps.map((microstep) => microstep.transitions[0]?.trigger.type),
        ["done"]
      )
      assert.deepStrictEqual(
        reference.steps[0]?.microsteps.map((microstep) => microstep.transitions[0]?.trigger.type),
        ["event", "done"]
      )
      assert.deepStrictEqual(reference.initial.state.completions, reference.steps[0]?.after.completions)

      const machine = MachineTest.compileModel(model)
      const trace = yield* MachineTest.run(machine, { events: [event("Reset")] })
      yield* MachineTest.verifyModel(model, trace)
    }))

  it.effect("fails bounded planning for separate always and completion cycles", () =>
    Effect.gen(function*() {
      const always: MachineTest.FiniteModel = {
        roots: [
          { _tag: "Atomic", key: "left", value: 0 },
          { _tag: "Atomic", key: "right", value: 1 }
        ],
        initial: "left",
        events: ["Tick"],
        transitions: [
          { source: "left", trigger: { type: "always" }, target: "right" },
          { source: "right", trigger: { type: "always" }, target: "left" }
        ]
      }
      const completion: MachineTest.FiniteModel = {
        roots: [
          {
            _tag: "Compound",
            key: "left",
            value: 0,
            initial: "done",
            states: [{ _tag: "Final", key: "done", value: 1, output: "left:done" }]
          },
          {
            _tag: "Compound",
            key: "right",
            value: 2,
            initial: "done",
            states: [{ _tag: "Final", key: "done", value: 3, output: "right:done" }]
          }
        ],
        initial: "left",
        events: ["Tick"],
        transitions: [
          { source: "left", trigger: { type: "done" }, target: "right" },
          { source: "right", trigger: { type: "done" }, target: "left" }
        ]
      }

      for (const model of [always, completion]) {
        // `compileModel` deliberately erases the generated machine to `Any`;
        // planning readiness is established by the compiler for this fixture.
        const error = yield* Machine.planInitial(MachineTest.compileModel(model) as any).pipe(Effect.flip)
        assert.instanceOf(error, Machine.InfiniteTransitionError)
        assert.strictEqual(error.maxIterations, 1000)
      }
    }))

  const parallelWorkflow = (
    transitions: ReadonlyArray<MachineTest.FiniteTransition>
  ): MachineTest.FiniteModel => ({
    roots: [
      {
        _tag: "Parallel",
        key: "workflow",
        value: 0,
        output: "workflow:complete",
        states: [
          {
            _tag: "Compound",
            key: "left",
            value: 1,
            initial: "idle",
            states: [
              { _tag: "Atomic", key: "idle", value: 2 },
              { _tag: "Final", key: "done", value: 3, output: "left:done" }
            ]
          },
          {
            _tag: "Compound",
            key: "right",
            value: 4,
            initial: "idle",
            states: [
              { _tag: "Atomic", key: "idle", value: 5 },
              { _tag: "Final", key: "done", value: 6, output: "right:done" }
            ]
          }
        ]
      },
      { _tag: "Atomic", key: "failed", value: 7 },
      { _tag: "Atomic", key: "cancelled", value: 8 }
    ],
    initial: "workflow",
    events: ["Both", "Left", "Right", "Abort"],
    transitions
  })

  const completionTransitions: ReadonlyArray<MachineTest.FiniteTransition> = [
    {
      source: "workflow.left.idle",
      trigger: { type: "event", event: "Both" },
      target: "workflow.left.done",
      reenter: false
    },
    {
      source: "workflow.right.idle",
      trigger: { type: "event", event: "Both" },
      target: "workflow.right.done",
      reenter: false
    },
    {
      source: "workflow.left.idle",
      trigger: { type: "event", event: "Left" },
      target: "workflow.left.done",
      reenter: false
    },
    {
      source: "workflow.right.idle",
      trigger: { type: "event", event: "Right" },
      target: "workflow.right.done",
      reenter: false
    }
  ]

  const idleParallelRegions = (offset: number): ReadonlyArray<MachineTest.FiniteState> => [
    {
      _tag: "Compound",
      key: "left",
      value: offset,
      initial: "idle",
      states: [{ _tag: "Atomic", key: "idle", value: offset + 1 }]
    },
    {
      _tag: "Compound",
      key: "right",
      value: offset + 2,
      initial: "idle",
      states: [{ _tag: "Atomic", key: "idle", value: offset + 3 }]
    }
  ]

  it.effect("retains simultaneous transitions in two orthogonal regions", () =>
    Effect.gen(function*() {
      const model = parallelWorkflow(completionTransitions)
      const reference = MachineTest.interpretModel(model, ["Both"])
      const microstep = reference.steps[0]!.microsteps[0]!

      assert.deepStrictEqual(microstep.transitions.map(({ source }) => source), [
        "workflow.left.idle",
        "workflow.right.idle"
      ])
      assert.deepStrictEqual(microstep.exitPaths, ["workflow.right.idle", "workflow.left.idle"])
      assert.deepStrictEqual(microstep.entryPaths, ["workflow.left.done", "workflow.right.done"])
      assert.strictEqual(reference.steps[0]!.done, true)
      assert.strictEqual(reference.steps[0]!.output, "workflow:complete")

      const machine = MachineTest.compileModel(model)
      const trace = yield* MachineTest.run(machine, { events: [event("Both")] })
      yield* MachineTest.verifyModel(model, trace)
    }))

  it.effect("propagates parallel completion into its completion transition", () =>
    Effect.gen(function*() {
      const model = parallelWorkflow([
        ...completionTransitions,
        { source: "workflow", trigger: { type: "done" }, target: "failed" }
      ])
      const reference = MachineTest.interpretModel(model, ["Both"])

      assert.deepStrictEqual(
        reference.steps[0]!.microsteps.map((microstep) =>
          microstep.transitions.map(({ source, trigger }) => ({ source, trigger }))
        ),
        [
          [
            { source: "workflow.left.idle", trigger: { type: "event", event: "Both" } },
            { source: "workflow.right.idle", trigger: { type: "event", event: "Both" } }
          ],
          [{ source: "workflow", trigger: { type: "done" } }]
        ]
      )
      assert.deepStrictEqual(reference.final.activePaths, ["failed"])

      const machine = MachineTest.compileModel(model)
      const trace = yield* MachineTest.run(machine, { events: [event("Both")] })
      yield* MachineTest.verifyModel(model, trace)
    }))

  it.effect("enters a choice from an always transition without a second trigger representation", () =>
    Effect.gen(function*() {
      const model: MachineTest.FiniteModel = {
        roots: [{
          _tag: "Compound",
          key: "flow",
          value: 0,
          initial: "idle",
          states: [
            { _tag: "Atomic", key: "idle", value: 1 },
            {
              _tag: "Choice",
              key: "route",
              targets: ["flow.ready"],
              selected: "flow.ready"
            },
            { _tag: "Atomic", key: "ready", value: 2 }
          ]
        }],
        initial: "flow",
        events: ["Unused"],
        transitions: [{
          source: "flow.idle",
          trigger: { type: "always" },
          target: "flow.route"
        }]
      }
      const reference = MachineTest.interpretModel(model, [])

      assert.deepStrictEqual(
        reference.initial.microsteps[0]!.transitions.map(({ source, trigger }) => ({ source, trigger })),
        [
          { source: "flow.idle", trigger: { type: "always" } },
          { source: "flow.route", trigger: { type: "choice" } }
        ]
      )
      assert.deepStrictEqual(reference.final.activePaths, ["flow", "flow.ready"])

      const machine = MachineTest.compileModel(model)
      const trace = yield* MachineTest.run(machine, { events: [] })
      yield* MachineTest.verifyModel(model, trace)
    }))

  it.effect("follows choice chains entered through a selected compound initializer", () =>
    Effect.gen(function*() {
      const model: MachineTest.FiniteModel = {
        roots: [
          { _tag: "Atomic", key: "idle", value: 0 },
          {
            _tag: "Compound",
            key: "workflow",
            value: 1,
            initial: "route",
            states: [
              {
                _tag: "Compound",
                key: "running",
                value: 2,
                initial: "phase",
                states: [
                  { _tag: "Atomic", key: "ready", value: 3 },
                  {
                    _tag: "Choice",
                    key: "phase",
                    targets: ["workflow.running.ready"],
                    selected: "workflow.running.ready"
                  }
                ]
              },
              {
                _tag: "Choice",
                key: "route",
                targets: ["workflow.running"],
                selected: "workflow.running"
              }
            ]
          }
        ],
        initial: "idle",
        events: ["Start"],
        transitions: [{
          source: "idle",
          trigger: { type: "event", event: "Start" },
          target: "workflow",
          reenter: false
        }]
      }
      const reference = MachineTest.interpretModel(model, ["Start"])

      assert.deepStrictEqual(
        reference.steps[0]!.microsteps[0]!.transitions.map(({ source }) => source),
        ["idle", "workflow.route", "workflow.running.phase"]
      )
      assert.deepStrictEqual(reference.final.activePaths, [
        "workflow",
        "workflow.running",
        "workflow.running.ready"
      ])

      const machine = MachineTest.compileModel(model)
      const trace = yield* MachineTest.run(machine, { events: [event("Start")] })
      yield* MachineTest.verifyModel(model, trace)
    }))

  it.effect("lets a child transition preempt an enabled parallel ancestor", () =>
    Effect.gen(function*() {
      const model = parallelWorkflow([
        { source: "workflow", trigger: { type: "event", event: "Abort" }, target: "failed", reenter: false },
        {
          source: "workflow.left.idle",
          trigger: { type: "event", event: "Abort" },
          target: "workflow.left.done",
          reenter: false
        }
      ])
      const reference = MachineTest.interpretModel(model, ["Abort"])
      assert.deepStrictEqual(reference.steps[0]!.microsteps[0]!.transitions.map(({ source }) => source), [
        "workflow.left.idle"
      ])
      assert.deepStrictEqual(reference.steps[0]!.after.activePaths, [
        "workflow",
        "workflow.left",
        "workflow.left.done",
        "workflow.right",
        "workflow.right.idle"
      ])

      const machine = MachineTest.compileModel(model)
      const trace = yield* MachineTest.run(machine, { events: [event("Abort")] })
      yield* MachineTest.verifyModel(model, trace)
    }))

  it.effect("uses source document order for conflicting cross-root targets", () =>
    Effect.gen(function*() {
      const model = parallelWorkflow([
        { source: "workflow.left.idle", trigger: { type: "event", event: "Abort" }, target: "failed", reenter: false },
        {
          source: "workflow.right.idle",
          trigger: { type: "event", event: "Abort" },
          target: "cancelled",
          reenter: false
        }
      ])
      const reference = MachineTest.interpretModel(model, ["Abort"])
      assert.deepStrictEqual(reference.steps[0]!.microsteps[0]!.transitions.map(({ source }) => source), [
        "workflow.left.idle"
      ])
      assert.deepStrictEqual(reference.steps[0]!.after.activePaths, ["failed"])

      const machine = MachineTest.compileModel(model)
      const trace = yield* MachineTest.run(machine, { events: [event("Abort")] })
      yield* MachineTest.verifyModel(model, trace)
    }))

  it.effect("preserves an unaffected sibling and completes parallel state only after every region", () =>
    Effect.gen(function*() {
      const model = parallelWorkflow(completionTransitions)
      const reference = MachineTest.interpretModel(model, ["Left", "Right"])
      const afterLeft = reference.steps[0]!.after

      assert.deepStrictEqual(afterLeft.activePaths, [
        "workflow",
        "workflow.left",
        "workflow.left.done",
        "workflow.right",
        "workflow.right.idle"
      ])
      assert.strictEqual(reference.steps[0]!.done, false)
      assert.deepStrictEqual(afterLeft.completions, [
        { path: "workflow.left.done", output: "left:done" },
        { path: "workflow.left", output: "left:done" }
      ])

      const afterRight = reference.steps[1]!.after
      assert.strictEqual(reference.steps[1]!.done, true)
      assert.strictEqual(reference.steps[1]!.output, "workflow:complete")
      assert.ok(afterRight.completions.some(({ path, output }) => path === "workflow.left" && output === "left:done"))
      assert.ok(
        afterRight.completions.some(({ path, output }) => path === "workflow" && output === "workflow:complete")
      )

      const machine = MachineTest.compileModel(model)
      const trace = yield* MachineTest.run(machine, { events: [event("Left"), event("Right")] })
      yield* MachineTest.verifyModel(model, trace)
    }))

  it.effect("initializes every region when a same-root transition directly targets a parallel state", () =>
    Effect.gen(function*() {
      const model: MachineTest.FiniteModel = {
        roots: [{
          _tag: "Compound",
          key: "app",
          value: 0,
          initial: "idle",
          states: [
            { _tag: "Atomic", key: "idle", value: 1 },
            {
              _tag: "Parallel",
              key: "work",
              value: 2,
              output: "work:complete",
              states: idleParallelRegions(3)
            }
          ]
        }],
        initial: "app",
        events: ["Enter"],
        transitions: [{
          source: "app.idle",
          trigger: { type: "event", event: "Enter" },
          target: "app.work",
          reenter: false
        }]
      }

      const reference = MachineTest.interpretModel(model, ["Enter"])
      assert.deepStrictEqual(reference.steps[0]!.after.activePaths, [
        "app",
        "app.work",
        "app.work.left",
        "app.work.left.idle",
        "app.work.right",
        "app.work.right.idle"
      ])
      assert.strictEqual(reference.steps[0]!.microsteps[0]!.transitions[0]!.resolvedTarget, "app.work")

      const machine = MachineTest.compileModel(model)
      const trace = yield* MachineTest.run(machine, { events: [event("Enter")] })
      yield* MachineTest.verifyModel(model, trace)
    }))

  it.effect("follows a same-root compound target through its initial parallel state", () =>
    Effect.gen(function*() {
      const model: MachineTest.FiniteModel = {
        roots: [{
          _tag: "Compound",
          key: "app",
          value: 0,
          initial: "idle",
          states: [
            { _tag: "Atomic", key: "idle", value: 1 },
            {
              _tag: "Compound",
              key: "running",
              value: 2,
              initial: "work",
              states: [{
                _tag: "Parallel",
                key: "work",
                value: 3,
                output: "work:complete",
                states: idleParallelRegions(4)
              }]
            }
          ]
        }],
        initial: "app",
        events: ["Enter"],
        transitions: [{
          source: "app.idle",
          trigger: { type: "event", event: "Enter" },
          target: "app.running",
          reenter: false
        }]
      }

      const reference = MachineTest.interpretModel(model, ["Enter"])
      assert.deepStrictEqual(reference.steps[0]!.after.activePaths, [
        "app",
        "app.running",
        "app.running.work",
        "app.running.work.left",
        "app.running.work.left.idle",
        "app.running.work.right",
        "app.running.work.right.idle"
      ])
      assert.strictEqual(
        reference.steps[0]!.microsteps[0]!.transitions[0]!.resolvedTarget,
        "app.running.work"
      )

      const machine = MachineTest.compileModel(model)
      const trace = yield* MachineTest.run(machine, { events: [event("Enter")] })
      yield* MachineTest.verifyModel(model, trace)
    }))

  it.effect("preserves sibling regions when targeting a nested state from within an active parallel region", () =>
    Effect.gen(function*() {
      const model: MachineTest.FiniteModel = {
        roots: [{
          _tag: "Compound",
          key: "app",
          value: 0,
          initial: "work",
          states: [{
            _tag: "Parallel",
            key: "work",
            value: 1,
            output: "work:complete",
            states: [
              {
                _tag: "Compound",
                key: "left",
                value: 2,
                initial: "idle",
                states: [
                  { _tag: "Atomic", key: "idle", value: 3 },
                  {
                    _tag: "Compound",
                    key: "running",
                    value: 4,
                    initial: "first",
                    states: [
                      { _tag: "Atomic", key: "first", value: 5 },
                      { _tag: "Atomic", key: "second", value: 6 }
                    ]
                  }
                ]
              },
              {
                _tag: "Compound",
                key: "right",
                value: 7,
                initial: "idle",
                states: [{ _tag: "Atomic", key: "idle", value: 8 }]
              }
            ]
          }]
        }],
        initial: "app",
        events: ["Advance"],
        transitions: [{
          source: "app.work.left.idle",
          trigger: { type: "event", event: "Advance" },
          target: "app.work.left.running",
          reenter: false
        }]
      }

      const reference = MachineTest.interpretModel(model, ["Advance"])
      assert.deepStrictEqual(reference.steps[0]!.after.activePaths, [
        "app",
        "app.work",
        "app.work.left",
        "app.work.left.running",
        "app.work.left.running.first",
        "app.work.right",
        "app.work.right.idle"
      ])
      assert.deepStrictEqual(reference.steps[0]!.microsteps[0]!.exitPaths, ["app.work.left.idle"])
      assert.deepStrictEqual(reference.steps[0]!.microsteps[0]!.entryPaths, [
        "app.work.left.running",
        "app.work.left.running.first"
      ])

      const machine = MachineTest.compileModel(model)
      const trace = yield* MachineTest.run(machine, { events: [event("Advance")] })
      yield* MachineTest.verifyModel(model, trace)
    }))

  it.effect("reinitializes only the source region when targeting an active parallel ancestor", () =>
    Effect.gen(function*() {
      const model: MachineTest.FiniteModel = {
        roots: [{
          _tag: "Compound",
          key: "app",
          value: 0,
          initial: "work",
          states: [{
            _tag: "Parallel",
            key: "work",
            value: 1,
            output: "work:complete",
            states: [
              {
                _tag: "Compound",
                key: "left",
                value: 2,
                initial: "idle",
                states: [
                  { _tag: "Atomic", key: "idle", value: 3 },
                  { _tag: "Atomic", key: "alternate", value: 4 }
                ]
              },
              {
                _tag: "Compound",
                key: "right",
                value: 5,
                initial: "idle",
                states: [
                  { _tag: "Atomic", key: "idle", value: 6 },
                  { _tag: "Atomic", key: "alternate", value: 7 }
                ]
              }
            ]
          }]
        }],
        initial: "app",
        events: ["Move", "ResetParallel", "ResetCompound"],
        transitions: [
          {
            source: "app.work.left.idle",
            trigger: { type: "event", event: "Move" },
            target: "app.work.left.alternate",
            reenter: false
          },
          {
            source: "app.work.right.idle",
            trigger: { type: "event", event: "Move" },
            target: "app.work.right.alternate",
            reenter: false
          },
          {
            source: "app.work.left.alternate",
            trigger: { type: "event", event: "ResetParallel" },
            target: "app.work",
            reenter: false
          },
          {
            source: "app.work.left.alternate",
            trigger: { type: "event", event: "ResetCompound" },
            target: "app",
            reenter: false
          }
        ]
      }
      const expected = [
        "app",
        "app.work",
        "app.work.left",
        "app.work.left.idle",
        "app.work.right",
        "app.work.right.alternate"
      ]

      for (const reset of ["ResetParallel", "ResetCompound"]) {
        const reference = MachineTest.interpretModel(model, ["Move", reset])
        assert.deepStrictEqual(reference.steps[1]!.after.activePaths, expected)
        assert.strictEqual(
          reference.steps[1]!.microsteps[0]!.transitions[0]!.resolvedTarget,
          "app.work.left.idle"
        )

        const machine = MachineTest.compileModel(model)
        const trace = yield* MachineTest.run(machine, { events: [event("Move"), event(reset)] })
        yield* MachineTest.verifyModel(model, trace)
      }
    }))

  it.effect("initializes every region when a cross-root transition fully targets a parallel root", () =>
    Effect.gen(function*() {
      const model: MachineTest.FiniteModel = {
        roots: [
          { _tag: "Atomic", key: "idle", value: 0 },
          {
            _tag: "Parallel",
            key: "work",
            value: 1,
            output: "work:complete",
            states: idleParallelRegions(2)
          }
        ],
        initial: "idle",
        events: ["Enter"],
        transitions: [{ source: "idle", trigger: { type: "event", event: "Enter" }, target: "work", reenter: false }]
      }

      const reference = MachineTest.interpretModel(model, ["Enter"])
      assert.deepStrictEqual(reference.steps[0]!.after.activePaths, [
        "work",
        "work.left",
        "work.left.idle",
        "work.right",
        "work.right.idle"
      ])
      assert.strictEqual(reference.steps[0]!.microsteps[0]!.transitions[0]!.resolvedTarget, "work")

      const machine = MachineTest.compileModel(model)
      const trace = yield* MachineTest.run(machine, { events: [event("Enter")] })
      yield* MachineTest.verifyModel(model, trace)
    }))

  it.effect("rejects parallel selection, conflict, retention, and configuration mutations", () =>
    Effect.gen(function*() {
      const simultaneousModel = parallelWorkflow(completionTransitions)
      const simultaneousMachine = MachineTest.compileModel(simultaneousModel)
      const simultaneous = yield* MachineTest.run(simultaneousMachine, { events: [event("Both")] })
      const simultaneousStep = simultaneous.steps[0]!
      const simultaneousMicrostep = simultaneousStep.plan.microsteps[0]!
      const dropped = {
        ...simultaneous,
        steps: [{
          ...simultaneousStep,
          plan: {
            ...simultaneousStep.plan,
            microsteps: [{
              ...simultaneousMicrostep,
              transitions: simultaneousMicrostep.transitions.slice(0, 1)
            }]
          }
        }]
      } as typeof simultaneous
      const droppedError = yield* MachineTest.verifyModel(simultaneousModel, dropped).pipe(Effect.flip)
      assert.include(fields(droppedError), "microstep.transitions")

      const ancestorModel = parallelWorkflow([
        { source: "workflow", trigger: { type: "event", event: "Abort" }, target: "failed", reenter: false },
        {
          source: "workflow.left.idle",
          trigger: { type: "event", event: "Abort" },
          target: "workflow.left.done",
          reenter: false
        }
      ])
      const ancestorMachine = MachineTest.compileModel(ancestorModel)
      const ancestor = yield* MachineTest.run(ancestorMachine, { events: [event("Abort")] })
      const ancestorStep = ancestor.steps[0]!
      const ancestorMicrostep = ancestorStep.plan.microsteps[0]!
      const choseAncestor = {
        ...ancestor,
        steps: [{
          ...ancestorStep,
          plan: {
            ...ancestorStep.plan,
            microsteps: [{
              ...ancestorMicrostep,
              transitions: [{ ...ancestorMicrostep.transitions[0]!, source: "workflow" }]
            }]
          }
        }]
      } as typeof ancestor
      const ancestorError = yield* MachineTest.verifyModel(ancestorModel, choseAncestor).pipe(Effect.flip)
      assert.include(fields(ancestorError), "microstep.transitions")

      const conflictModel = parallelWorkflow([
        { source: "workflow.left.idle", trigger: { type: "event", event: "Abort" }, target: "failed", reenter: false },
        {
          source: "workflow.right.idle",
          trigger: { type: "event", event: "Abort" },
          target: "cancelled",
          reenter: false
        }
      ])
      const reversedModel = parallelWorkflow([
        {
          source: "workflow.left.idle",
          trigger: { type: "event", event: "Abort" },
          target: "cancelled",
          reenter: false
        },
        { source: "workflow.right.idle", trigger: { type: "event", event: "Abort" }, target: "failed", reenter: false }
      ])
      const reversedMachine = MachineTest.compileModel(reversedModel)
      const reversed = yield* MachineTest.run(reversedMachine, { events: [event("Abort")] })
      const conflictError = yield* MachineTest.verifyModel(conflictModel, reversed).pipe(Effect.flip)
      assert.include(fields(conflictError), "microstep.transitions")
      assert.include(fields(conflictError), "step.plan.next.activePaths")

      const initial = simultaneous.initial.startingState as any
      const omitted = { ...initial, states: { left: initial.states.left } }
      const omittedPaths = ["workflow", "workflow.left", "workflow.left.idle"]
      const omittedTrace = {
        ...simultaneous,
        scenario: { events: [] },
        initial: {
          ...simultaneous.initial,
          startingState: omitted,
          startingConfiguration: omittedPaths,
          initialEntryPaths: omittedPaths,
          configuration: omittedPaths,
          plan: {
            ...simultaneous.initial.plan,
            startingState: omitted,
            initialEntryPaths: omittedPaths,
            state: omitted,
            microsteps: [],
            done: false,
            output: undefined
          }
        },
        steps: [],
        final: omitted,
        finalConfiguration: omittedPaths
      } as unknown as typeof simultaneous
      const omittedError = yield* MachineTest.verifyModel(simultaneousModel, omittedTrace).pipe(Effect.flip)
      assert.include(fields(omittedError), "initial.startingState.activePaths")
    }))

  it.effect("applies value-only targets before control changes without resurrecting exited branches", () =>
    Effect.gen(function*() {
      const Root = Schema.TaggedStruct("Root", { version: Schema.Number })
      const Left = Schema.TaggedStruct("Left", { version: Schema.Number })
      const LeftIdle = Schema.TaggedStruct("LeftIdle", { version: Schema.Number })
      const LeftDone = Schema.TaggedStruct("LeftDone", { version: Schema.Number })
      const Right = Schema.TaggedStruct("Right", { version: Schema.Number })
      const RightIdle = Schema.TaggedStruct("RightIdle", { version: Schema.Number })
      const Outside = Schema.TaggedStruct("Outside", { version: Schema.Number })
      const Local = Schema.TaggedStruct("Local", {})
      const Exit = Schema.TaggedStruct("Exit", {})
      const states = Machine.defineStates({
        root: {
          schema: Root,
          type: "parallel",
          states: {
            left: {
              schema: Left,
              initial: "idle",
              states: { idle: LeftIdle, done: LeftDone }
            },
            right: {
              schema: Right,
              initial: "idle",
              states: { idle: RightIdle }
            }
          }
        },
        outside: Outside
      })
      const machine = Machine.make({
        states: states.states,
        events: [Local, Exit],
        initial: () =>
          states.initial.root({ _tag: "Root", version: 0 }, (regions) =>
            regions
              .left({ _tag: "Left", version: 0 }, (left) => left.idle({ _tag: "LeftIdle", version: 0 }))
              .right({ _tag: "Right", version: 0 }, (right) => right.idle({ _tag: "RightIdle", version: 0 })))
      }).handle({
        root: {
          states: {
            left: {
              states: {
                idle: {
                  on: {
                    Local: ({ target }) => target.local.done({ _tag: "LeftDone", version: 1 }),
                    Exit: ({ target }) => target.full.outside({ _tag: "Outside", version: 1 })
                  }
                }
              }
            },
            right: {
              states: {
                idle: {
                  on: {
                    Local: ({ target }) => target.local.idle({ _tag: "RightIdle", version: 1 }),
                    Exit: ({ target }) => target.local.idle({ _tag: "RightIdle", version: 2 })
                  }
                }
              }
            }
          }
        }
      })

      const initial = yield* Machine.planInitial(machine)
      const local = yield* Machine.plan(machine, initial.state, { _tag: "Local" })
      assert.strictEqual((local.next as any).states.left.state.path, "root.left.done")
      assert.strictEqual((local.next as any).states.right.state.value.version, 1)

      const exited = yield* Machine.plan(machine, initial.state, { _tag: "Exit" })
      assert.strictEqual(exited.next.path, "outside")
      assert.deepStrictEqual(exited.microsteps[0]!.transitions.map(({ source }) => source), [
        "root.left.idle",
        "root.right.idle"
      ])
    }))

  it.effect("initializes the default descendants of a same-root compound target", () =>
    Effect.gen(function*() {
      const model: MachineTest.FiniteModel = {
        roots: [{
          _tag: "Compound",
          key: "workflow",
          value: 0,
          initial: "idle",
          states: [
            { _tag: "Atomic", key: "idle", value: 1 },
            {
              _tag: "Compound",
              key: "running",
              value: 2,
              initial: "first",
              states: [
                { _tag: "Atomic", key: "first", value: 3 },
                { _tag: "Atomic", key: "second", value: 4 }
              ]
            }
          ]
        }],
        initial: "workflow",
        events: ["Start"],
        transitions: [{
          source: "workflow.idle",
          trigger: { type: "event", event: "Start" },
          target: "workflow.running",
          reenter: false
        }]
      }

      const reference = MachineTest.interpretModel(model, ["Start"])
      assert.deepStrictEqual(reference.initial.startingState.activePaths, ["workflow", "workflow.idle"])
      assert.deepStrictEqual(reference.steps[0]?.after.activePaths, [
        "workflow",
        "workflow.running",
        "workflow.running.first"
      ])
      assert.deepStrictEqual(reference.steps[0]?.microsteps[0]?.exitPaths, ["workflow.idle"])
      assert.deepStrictEqual(reference.steps[0]?.microsteps[0]?.entryPaths, [
        "workflow.running",
        "workflow.running.first"
      ])
      assert.deepStrictEqual(reference.steps[0]?.after.values["workflow.running.first"], {
        _tag: "State_workflow_running_first",
        value: 3
      })

      const machine = MachineTest.compileModel(model)
      const trace = yield* MachineTest.run(machine, { events: [event("Start")] })
      yield* MachineTest.verifyModel(model, trace)
    }))

  it.effect("retains a direct final root output and ignores later events", () =>
    Effect.gen(function*() {
      const model: MachineTest.FiniteModel = {
        roots: [{ _tag: "Final", key: "finished", value: 42, output: "complete" }],
        initial: "finished",
        events: ["After"],
        transitions: []
      }

      const reference = MachineTest.interpretModel(model, ["After"])
      assert.deepStrictEqual(reference.initial.startingState.completions, [])
      assert.deepStrictEqual(reference.initial.state.completions, [{ path: "finished", output: "complete" }])
      assert.strictEqual(reference.initial.done, true)
      assert.strictEqual(reference.initial.output, "complete")
      assert.strictEqual(reference.steps[0]?.done, true)
      assert.strictEqual(reference.steps[0]?.output, "complete")
      assert.deepStrictEqual(reference.steps[0]?.microsteps, [])

      const machine = MachineTest.compileModel(model)
      const trace = yield* MachineTest.run(machine, { events: [event("After")] })
      yield* MachineTest.verifyModel(model, trace)
    }))

  it.effect("propagates a direct final child through compound completion", () =>
    Effect.gen(function*() {
      const model: MachineTest.FiniteModel = {
        roots: [{
          _tag: "Compound",
          key: "job",
          value: 0,
          initial: "done",
          states: [{ _tag: "Final", key: "done", value: 1, output: "result" }]
        }],
        initial: "job",
        events: ["Unused"],
        transitions: []
      }

      const reference = MachineTest.interpretModel(model, [])
      assert.deepStrictEqual(reference.initial.state.completions, [
        { path: "job.done", output: "result" },
        { path: "job", output: "result" }
      ])
      assert.strictEqual(reference.initial.state.status, "done")
      assert.strictEqual(reference.initial.output, "result")

      const machine = MachineTest.compileModel(model)
      const trace = yield* MachineTest.run(machine, { events: [] })
      yield* MachineTest.verifyModel(model, trace)
    }))

  it.effect("propagates nested completion through a completion transition to the parent final", () =>
    Effect.gen(function*() {
      const model: MachineTest.FiniteModel = {
        roots: [{
          _tag: "Compound",
          key: "job",
          value: 0,
          initial: "phase",
          states: [
            {
              _tag: "Compound",
              key: "phase",
              value: 1,
              initial: "done",
              states: [{ _tag: "Final", key: "done", value: 2, output: "phase:done" }]
            },
            { _tag: "Final", key: "done", value: 3, output: "job:done" }
          ]
        }],
        initial: "job",
        events: ["Unused"],
        transitions: [{
          source: "job.phase",
          trigger: { type: "done" },
          target: "job.done"
        }]
      }
      const reference = MachineTest.interpretModel(model, [])

      assert.deepStrictEqual(
        reference.initial.microsteps.flatMap((microstep) => microstep.transitions.map(({ trigger }) => trigger)),
        [{ type: "done" }]
      )
      assert.deepStrictEqual(reference.final.completions, [
        { path: "job.done", output: "job:done" },
        { path: "job", output: "job:done" }
      ])
      assert.strictEqual(reference.final.status, "done")

      const machine = MachineTest.compileModel(model)
      const trace = yield* MachineTest.run(machine, { events: [] })
      yield* MachineTest.verifyModel(model, trace)
    }))

  it.effect("models targetless steps, broadened reentry, and cross-root lifecycle order", () =>
    Effect.gen(function*() {
      const model: MachineTest.FiniteModel = {
        roots: [
          {
            _tag: "Compound",
            key: "left",
            value: 0,
            initial: "branch",
            states: [{
              _tag: "Compound",
              key: "branch",
              value: 1,
              initial: "leaf",
              states: [{ _tag: "Atomic", key: "leaf", value: 2 }]
            }]
          },
          {
            _tag: "Compound",
            key: "right",
            value: 3,
            initial: "idle",
            states: [{ _tag: "Atomic", key: "idle", value: 4 }]
          }
        ],
        initial: "left",
        events: ["Noop", "Reenter", "Switch"],
        transitions: [
          { source: "left.branch.leaf", trigger: { type: "event", event: "Noop" }, reenter: false },
          { source: "left.branch", trigger: { type: "event", event: "Reenter" }, target: "left.branch", reenter: true },
          { source: "left.branch.leaf", trigger: { type: "event", event: "Switch" }, target: "right", reenter: false }
        ]
      }

      const reference = MachineTest.interpretModel(model, ["Noop", "Reenter", "Switch"])
      assert.deepStrictEqual(reference.steps[0]?.microsteps[0], {
        next: reference.steps[0]!.before,
        event: "Noop",
        transitions: [{
          source: "left.branch.leaf",
          trigger: { type: "event", event: "Noop" },
          reenter: false,
          target: undefined,
          resolvedTarget: undefined
        }],
        exitPaths: [],
        entryPaths: [],
        changed: false
      })
      assert.deepStrictEqual(reference.steps[1]?.microsteps[0]?.exitPaths, [
        "left.branch.leaf",
        "left.branch"
      ])
      assert.deepStrictEqual(reference.steps[1]?.microsteps[0]?.entryPaths, [
        "left.branch",
        "left.branch.leaf"
      ])
      assert.deepStrictEqual(reference.steps[2]?.microsteps[0]?.exitPaths, [
        "left.branch.leaf",
        "left.branch",
        "left"
      ])
      assert.deepStrictEqual(reference.steps[2]?.microsteps[0]?.entryPaths, ["right", "right.idle"])
      assert.deepStrictEqual(reference.steps[2]?.microsteps[0]?.transitions[0]?.target, "right")

      const machine = MachineTest.compileModel(model)
      const trace = yield* MachineTest.run(machine, {
        events: [event("Noop"), event("Reenter"), event("Switch")]
      })
      yield* MachineTest.verifyModel(model, trace)
    }))

  it.effect("rejects an ancestor source when the active leaf transition has priority", () =>
    Effect.gen(function*() {
      const model: MachineTest.FiniteModel = {
        roots: [{
          _tag: "Compound",
          key: "root",
          value: 0,
          initial: "branch",
          states: [
            {
              _tag: "Compound",
              key: "branch",
              value: 1,
              initial: "leaf",
              states: [{ _tag: "Atomic", key: "leaf", value: 2 }]
            },
            { _tag: "Atomic", key: "other", value: 3 }
          ]
        }],
        initial: "root",
        events: ["Go"],
        transitions: [
          { source: "root.branch", trigger: { type: "event", event: "Go" }, target: "root.other", reenter: false },
          { source: "root.branch.leaf", trigger: { type: "event", event: "Go" }, target: "root.other", reenter: false }
        ]
      }
      const machine = MachineTest.compileModel(model)
      const trace = yield* MachineTest.run(machine, { events: [event("Go")] })
      const step = trace.steps[0]!
      const microstep = step.plan.microsteps[0]!
      const retained = microstep.transitions[0]!
      const corrupted = {
        ...trace,
        steps: [{
          ...step,
          plan: {
            ...step.plan,
            microsteps: [{
              ...microstep,
              transitions: [{ ...retained, source: "root.branch" }]
            }]
          }
        }]
      } as typeof trace

      // The mutated transition is declared and produces the same structurally
      // valid configuration, so only selection semantics distinguish it.
      yield* MachineTest.verify(machine, corrupted)
      const error = yield* MachineTest.verifyModel(model, corrupted).pipe(Effect.flip)
      assert.include(fields(error), "microstep.transitions")
    }))

  it.effect("rejects a valid sibling configuration in place of the declared initial branch", () =>
    Effect.gen(function*() {
      const model: MachineTest.FiniteModel = {
        roots: [{
          _tag: "Compound",
          key: "root",
          value: 0,
          initial: "left",
          states: [
            { _tag: "Atomic", key: "left", value: 1 },
            { _tag: "Atomic", key: "right", value: 2 }
          ]
        }],
        initial: "root",
        events: ["Unused"],
        transitions: []
      }
      const machine = MachineTest.compileModel(model)
      const trace = yield* MachineTest.run(machine, { events: [] })
      const right = {
        path: "root",
        value: { _tag: "State_root", value: 0 },
        state: {
          path: "root.right",
          value: { _tag: "State_root_right", value: 2 }
        }
      }
      const rightPaths = ["root", "root.right"]
      const corrupted = {
        ...trace,
        initial: {
          ...trace.initial,
          startingState: right,
          startingConfiguration: rightPaths,
          initialEntryPaths: rightPaths,
          configuration: rightPaths,
          plan: {
            ...trace.initial.plan,
            startingState: right,
            initialEntryPaths: rightPaths,
            state: right
          }
        },
        final: right,
        finalConfiguration: rightPaths
      } as typeof trace

      // The trace is self-consistent and every state/value is schema-valid,
      // but it does not represent the model's declared initial state.
      yield* MachineTest.verify(machine, corrupted)
      const error = yield* MachineTest.verifyModel(model, corrupted).pipe(Effect.flip)
      assert.include(fields(error), "initial.startingState.activePaths")
      assert.include(fields(error), "trace.final.activePaths")
    }))

  it.effect("rejects a self-consistent trace that drops an enabled transition", () =>
    Effect.gen(function*() {
      const model: MachineTest.FiniteModel = {
        roots: [
          { _tag: "Atomic", key: "idle", value: 0 },
          { _tag: "Atomic", key: "ready", value: 1 }
        ],
        initial: "idle",
        events: ["Start"],
        transitions: [{ source: "idle", trigger: { type: "event", event: "Start" }, target: "ready", reenter: false }]
      }
      const machine = MachineTest.compileModel(model)
      const trace = yield* MachineTest.run(machine, { events: [event("Start")] })
      const step = trace.steps[0]!
      const corrupted = {
        ...trace,
        steps: [{
          ...step,
          plan: {
            ...step.plan,
            next: step.before,
            microsteps: [],
            done: false,
            output: undefined
          },
          after: step.before,
          afterConfiguration: step.beforeConfiguration
        }],
        final: step.before,
        finalConfiguration: step.beforeConfiguration
      } as typeof trace

      yield* MachineTest.verify(machine, corrupted)
      const error = yield* MachineTest.verifyModel(model, corrupted).pipe(Effect.flip)
      assert.include(fields(error), "step.plan.microsteps.length")
      assert.include(fields(error), "step.plan.next.activePaths")
    }))

  const compoundHistoryModel = (
    history: "shallow" | "deep",
    initial: "workspace" | "outside" = "workspace"
  ): MachineTest.FiniteModel => ({
    roots: [
      {
        _tag: "Compound",
        key: "workspace",
        value: 0,
        initial: "editor",
        states: [
          {
            _tag: "Compound",
            key: "editor",
            value: 1,
            initial: "writing",
            states: [
              { _tag: "Atomic", key: "writing", value: 2 },
              { _tag: "Atomic", key: "preview", value: 3 }
            ]
          },
          { _tag: "History", key: "recent", history, fallback: "workspace.editor" }
        ]
      },
      { _tag: "Atomic", key: "outside", value: 4 }
    ],
    initial,
    events: ["Advance", "Reset", "Leave", "Resume"],
    transitions: [
      {
        source: "workspace.editor.writing",
        trigger: { type: "event", event: "Advance" },
        target: "workspace.editor.preview",
        reenter: false
      },
      {
        source: "workspace.editor.writing",
        trigger: { type: "event", event: "Leave" },
        target: "outside",
        reenter: false
      },
      {
        source: "workspace.editor.preview",
        trigger: { type: "event", event: "Reset" },
        target: "workspace.editor.writing",
        reenter: false
      },
      {
        source: "workspace.editor.preview",
        trigger: { type: "event", event: "Leave" },
        target: "outside",
        reenter: false
      },
      { source: "outside", trigger: { type: "event", event: "Resume" }, target: "workspace.recent", reenter: false }
    ]
  })

  it.effect("uses a history fallback entered by an always transition", () =>
    Effect.gen(function*() {
      const base = compoundHistoryModel("deep", "outside")
      const model: MachineTest.FiniteModel = {
        ...base,
        transitions: [{
          source: "outside",
          trigger: { type: "always" },
          target: "workspace.recent"
        }]
      }
      const reference = MachineTest.interpretModel(model, [])

      assert.deepStrictEqual(reference.final.activePaths, [
        "workspace",
        "workspace.editor",
        "workspace.editor.writing"
      ])
      assert.deepStrictEqual(reference.final.history, {})
      assert.deepStrictEqual(reference.initial.microsteps[0]!.transitions[0]!.trigger, { type: "always" })

      const machine = MachineTest.compileModel(model)
      const trace = yield* MachineTest.run(machine, { events: [] })
      yield* MachineTest.verifyModel(model, trace)
    }))

  it.effect("uses fallback only before capture, then deep history overwrites and reuses its register", () =>
    Effect.gen(function*() {
      const fallbackModel = compoundHistoryModel("deep", "outside")
      const fallbackReference = MachineTest.interpretModel(fallbackModel, ["Resume"])
      assert.deepStrictEqual(fallbackReference.final.activePaths, [
        "workspace",
        "workspace.editor",
        "workspace.editor.writing"
      ])
      assert.deepStrictEqual(fallbackReference.final.history, {})
      const fallbackMachine = MachineTest.compileModel(fallbackModel)
      const fallbackTrace = yield* MachineTest.run(fallbackMachine, { events: [event("Resume")] })
      yield* MachineTest.verifyModel(fallbackModel, fallbackTrace)

      const model = compoundHistoryModel("deep")
      const events = ["Advance", "Leave", "Resume", "Reset", "Leave", "Resume", "Leave", "Resume"]
      const reference = MachineTest.interpretModel(model, events)
      assert.deepStrictEqual(reference.steps[2]!.after.activePaths, [
        "workspace",
        "workspace.editor",
        "workspace.editor.preview"
      ])
      assert.deepStrictEqual(reference.steps[5]!.after.activePaths, [
        "workspace",
        "workspace.editor",
        "workspace.editor.writing"
      ])
      assert.deepStrictEqual(reference.final.activePaths, reference.steps[5]!.after.activePaths)
      assert.ok(reference.final.history["workspace.recent"]?.active.includes("workspace.editor.writing"))
      assert.ok(!reference.final.history["workspace.recent"]?.active.includes("workspace.editor.preview"))

      const machine = MachineTest.compileModel(model)
      const trace = yield* MachineTest.run(machine, { events: events.map(event) })
      yield* MachineTest.verify(machine, trace)
      yield* MachineTest.verifyModel(model, trace)
    }))

  it.effect("reinitializes descendants for shallow history instead of restoring the deep branch", () =>
    Effect.gen(function*() {
      const model = compoundHistoryModel("shallow")
      const events = ["Advance", "Leave", "Resume"]
      const reference = MachineTest.interpretModel(model, events)
      assert.deepStrictEqual(reference.final.activePaths, [
        "workspace",
        "workspace.editor",
        "workspace.editor.writing"
      ])
      assert.deepStrictEqual(reference.final.history["workspace.recent"]?.active, [
        "workspace",
        "workspace.editor"
      ])

      const machine = MachineTest.compileModel(model)
      const trace = yield* MachineTest.run(machine, { events: events.map(event) })
      yield* MachineTest.verifyModel(model, trace)
    }))

  const parallelHistoryModel = (): MachineTest.FiniteModel => ({
    roots: [
      {
        _tag: "Parallel",
        key: "workspace",
        value: 0,
        output: "workspace:done",
        states: [
          {
            _tag: "Compound",
            key: "editor",
            value: 1,
            initial: "idle",
            states: [
              { _tag: "Atomic", key: "idle", value: 2 },
              { _tag: "Atomic", key: "active", value: 3 }
            ]
          },
          {
            _tag: "Compound",
            key: "sidebar",
            value: 4,
            initial: "closed",
            states: [
              { _tag: "Atomic", key: "closed", value: 5 },
              { _tag: "Atomic", key: "open", value: 6 }
            ]
          },
          { _tag: "History", key: "recent", history: "shallow", fallback: "workspace.editor" },
          { _tag: "History", key: "exact", history: "deep", fallback: "workspace.editor" }
        ]
      },
      { _tag: "Atomic", key: "outside", value: 7 }
    ],
    initial: "workspace",
    events: ["Advance", "Leave", "ResumeShallow", "ResumeDeep"],
    transitions: [
      { source: "workspace", trigger: { type: "event", event: "Leave" }, target: "outside", reenter: false },
      {
        source: "workspace.editor.idle",
        trigger: { type: "event", event: "Advance" },
        target: "workspace.editor.active",
        reenter: false
      },
      {
        source: "workspace.sidebar.closed",
        trigger: { type: "event", event: "Advance" },
        target: "workspace.sidebar.open",
        reenter: false
      },
      {
        source: "outside",
        trigger: { type: "event", event: "ResumeShallow" },
        target: "workspace.recent",
        reenter: false
      },
      { source: "outside", trigger: { type: "event", event: "ResumeDeep" }, target: "workspace.exact", reenter: false }
    ]
  })

  it.effect("captures and restores every parallel region in shallow and deep modes", () =>
    Effect.gen(function*() {
      const model = parallelHistoryModel()
      const shallowEvents = ["Advance", "Leave", "ResumeShallow"]
      const shallow = MachineTest.interpretModel(model, shallowEvents)
      assert.deepStrictEqual(shallow.final.activePaths, [
        "workspace",
        "workspace.editor",
        "workspace.editor.idle",
        "workspace.sidebar",
        "workspace.sidebar.closed"
      ])
      assert.deepStrictEqual(shallow.final.history["workspace.recent"]?.active, [
        "workspace",
        "workspace.editor",
        "workspace.sidebar"
      ])

      const deepEvents = ["Advance", "Leave", "ResumeDeep"]
      const deep = MachineTest.interpretModel(model, deepEvents)
      assert.deepStrictEqual(deep.final.activePaths, [
        "workspace",
        "workspace.editor",
        "workspace.editor.active",
        "workspace.sidebar",
        "workspace.sidebar.open"
      ])
      assert.ok(deep.final.history["workspace.exact"]?.active.includes("workspace.editor.active"))
      assert.ok(deep.final.history["workspace.exact"]?.active.includes("workspace.sidebar.open"))

      for (const events of [shallowEvents, deepEvents]) {
        const machine = MachineTest.compileModel(model)
        const trace = yield* MachineTest.run(machine, { events: events.map(event) })
        yield* MachineTest.verifyModel(model, trace)
      }
    }))

  it.effect("restores nested history without disturbing a parallel sibling and self-reentry captures current state", () =>
    Effect.gen(function*() {
      const model: MachineTest.FiniteModel = {
        roots: [{
          _tag: "Parallel",
          key: "workspace",
          value: 0,
          output: "workspace:done",
          states: [
            {
              _tag: "Compound",
              key: "editor",
              value: 1,
              initial: "writing",
              states: [
                { _tag: "Atomic", key: "writing", value: 2 },
                { _tag: "Atomic", key: "preview", value: 3 },
                {
                  _tag: "History",
                  key: "exact",
                  history: "deep",
                  fallback: "workspace.editor.writing"
                }
              ]
            },
            {
              _tag: "Compound",
              key: "sidebar",
              value: 4,
              initial: "closed",
              states: [
                { _tag: "Atomic", key: "closed", value: 5 },
                { _tag: "Atomic", key: "open", value: 6 }
              ]
            }
          ]
        }],
        initial: "workspace",
        events: ["Advance", "Restore"],
        transitions: [
          {
            source: "workspace.editor.writing",
            trigger: { type: "event", event: "Advance" },
            target: "workspace.editor.preview",
            reenter: false
          },
          {
            source: "workspace.sidebar.open",
            trigger: { type: "event", event: "Restore" },
            target: "workspace.editor.exact",
            reenter: true
          },
          {
            source: "workspace.sidebar.closed",
            trigger: { type: "event", event: "Advance" },
            target: "workspace.sidebar.open",
            reenter: false
          }
        ]
      }
      const events = ["Advance", "Restore"]
      const reference = MachineTest.interpretModel(model, events)
      assert.deepStrictEqual(reference.final.activePaths, [
        "workspace",
        "workspace.editor",
        "workspace.editor.preview",
        "workspace.sidebar",
        "workspace.sidebar.open"
      ])
      assert.ok(reference.final.history["workspace.editor.exact"]?.active.includes("workspace.editor.preview"))
      assert.deepStrictEqual(reference.steps[1]!.microsteps[0]!.exitPaths, [
        "workspace.editor.preview",
        "workspace.editor"
      ])

      const machine = MachineTest.compileModel(model)
      const trace = yield* MachineTest.run(machine, { events: events.map(event) })
      yield* MachineTest.verify(machine, trace)
      yield* MachineTest.verifyModel(model, trace)

      const restoreStep = trace.steps[1]!
      const restoreMicrostep = restoreStep.plan.microsteps[0]!
      const injectedSiblingLifecycle = {
        ...trace,
        steps: [trace.steps[0]!, {
          ...restoreStep,
          plan: {
            ...restoreStep.plan,
            microsteps: [{
              ...restoreMicrostep,
              exitPaths: ["workspace.sidebar.open", ...restoreMicrostep.exitPaths],
              entryPaths: [...restoreMicrostep.entryPaths, "workspace.sidebar.open"]
            }]
          }
        }]
      } as typeof trace
      const lifecycleError = yield* MachineTest.verify(machine, injectedSiblingLifecycle).pipe(Effect.flip)
      assert.ok(
        lifecycleError.violations.some(({ law, path }) =>
          law === "microsteps.reentry" && path === "workspace.sidebar.open"
        )
      )
    }))

  const inactiveOuterHistoryModel = (
    initial: "workspace" | "outside"
  ): MachineTest.FiniteModel => ({
    roots: [
      {
        _tag: "Parallel",
        key: "workspace",
        value: 0,
        output: "workspace:done",
        states: [
          {
            _tag: "Compound",
            key: "editor",
            value: 1,
            initial: "writing",
            states: [
              { _tag: "Atomic", key: "writing", value: 2 },
              { _tag: "Atomic", key: "preview", value: 3 },
              {
                _tag: "History",
                key: "exact",
                history: "deep",
                fallback: "workspace.editor.writing"
              }
            ]
          },
          {
            _tag: "Compound",
            key: "sidebar",
            value: 4,
            initial: "closed",
            states: [
              { _tag: "Atomic", key: "closed", value: 5 },
              { _tag: "Atomic", key: "open", value: 6 }
            ]
          }
        ]
      },
      { _tag: "Atomic", key: "outside", value: 7 }
    ],
    initial,
    events: ["Advance", "Mutate", "Leave", "Resume"],
    transitions: [
      { source: "workspace", trigger: { type: "event", event: "Leave" }, target: "outside", reenter: false },
      {
        source: "workspace.editor.writing",
        trigger: { type: "event", event: "Mutate" },
        target: "workspace.editor.writing",
        targetValue: 42,
        reenter: false
      },
      {
        source: "workspace.editor.writing",
        trigger: { type: "event", event: "Advance" },
        target: "workspace.editor.preview",
        reenter: false
      },
      {
        source: "workspace.sidebar.closed",
        trigger: { type: "event", event: "Advance" },
        target: "workspace.sidebar.open",
        reenter: false
      },
      {
        source: "outside",
        trigger: { type: "event", event: "Resume" },
        target: "workspace.editor.exact",
        reenter: false
      }
    ]
  })

  it.effect("rebuilds inactive ancestors and initializes outer parallel siblings for recorded nested history", () =>
    Effect.gen(function*() {
      const model = inactiveOuterHistoryModel("workspace")
      const events = ["Advance", "Leave", "Resume"]
      const reference = MachineTest.interpretModel(model, events)
      assert.deepStrictEqual(reference.final.activePaths, [
        "workspace",
        "workspace.editor",
        "workspace.editor.preview",
        "workspace.sidebar",
        "workspace.sidebar.closed"
      ])
      assert.deepStrictEqual(reference.final.values.workspace, { _tag: "State_workspace", value: 0 })

      const machine = MachineTest.compileModel(model)
      const trace = yield* MachineTest.run(machine, { events: events.map(event) })
      yield* MachineTest.verify(machine, trace)
      yield* MachineTest.verifyModel(model, trace)
    }))

  it.effect("restores a non-default nested value after its outer root becomes inactive", () =>
    Effect.gen(function*() {
      const model = inactiveOuterHistoryModel("workspace")
      const events = ["Mutate", "Leave", "Resume"]
      const reference = MachineTest.interpretModel(model, events)
      assert.deepStrictEqual(reference.steps[0]!.after.values["workspace.editor.writing"], {
        _tag: "State_workspace_editor_writing",
        value: 42
      })
      assert.deepStrictEqual(reference.final.values["workspace.editor.writing"], {
        _tag: "State_workspace_editor_writing",
        value: 42
      })

      const machine = MachineTest.compileModel(model)
      const trace = yield* MachineTest.run(machine, { events: events.map(event) })
      const mutated = snapshotAtPath(trace.steps[0]!.after, "workspace.editor.writing") as any
      const restored = snapshotAtPath(trace.final, "workspace.editor.writing") as any
      assert.strictEqual(mutated.value.value, 42)
      assert.strictEqual(restored.value.value, 42)
      assert.strictEqual(
        (trace.final as any).history["workspace.editor.exact"].values["workspace.editor.writing"].value,
        42
      )
      yield* MachineTest.verify(machine, trace)
      yield* MachineTest.verifyModel(model, trace)
    }))

  it.effect("restores a first-use nested fallback through inactive compound and parallel ancestors", () =>
    Effect.gen(function*() {
      const model = inactiveOuterHistoryModel("outside")
      const machine = MachineTest.compileModel(model)
      const trace = yield* MachineTest.run(machine, { events: [event("Resume")] })

      assert.deepStrictEqual(trace.finalConfiguration, [
        "workspace",
        "workspace.editor",
        "workspace.editor.writing",
        "workspace.sidebar",
        "workspace.sidebar.closed"
      ])
      assert.deepStrictEqual((trace.final as any).history, undefined)
      yield* MachineTest.verify(machine, trace)
      yield* MachineTest.verifyModel(model, trace)
    }))

  it.effect("rejects consumed, shallow-as-deep, missing-region, and fallback-after-record mutations", () =>
    Effect.gen(function*() {
      const deepModel = compoundHistoryModel("deep")
      const deepMachine = MachineTest.compileModel(deepModel)
      const deepTrace = yield* MachineTest.run(deepMachine, {
        events: ["Advance", "Leave", "Resume", "Leave", "Resume"].map(event)
      })
      const consumed = { ...deepTrace, final: { ...(deepTrace.final as any), history: {} } } as typeof deepTrace
      const consumedError = yield* MachineTest.verifyModel(deepModel, consumed).pipe(Effect.flip)
      assert.include(fields(consumedError), "trace.final.history")

      const shallowModel = compoundHistoryModel("shallow")
      const shallowMachine = MachineTest.compileModel(shallowModel)
      const shallowTrace = yield* MachineTest.run(shallowMachine, {
        events: ["Advance", "Leave"].map(event)
      })
      const shallowFinal = shallowTrace.final as any
      const shallowRecord = shallowFinal.history["workspace.recent"]
      const shallowAsDeep = {
        ...shallowTrace,
        final: {
          ...shallowFinal,
          history: {
            ...shallowFinal.history,
            "workspace.recent": {
              ...shallowRecord,
              active: [...shallowRecord.active, "workspace.editor.preview"],
              values: {
                ...shallowRecord.values,
                "workspace.editor.preview": { _tag: "State_workspace_editor_preview", value: 3 }
              }
            }
          }
        }
      } as typeof shallowTrace
      const shallowError = yield* MachineTest.verifyModel(shallowModel, shallowAsDeep).pipe(Effect.flip)
      assert.include(fields(shallowError), "trace.final.history")

      const parallelModel = parallelHistoryModel()
      const parallelMachine = MachineTest.compileModel(parallelModel)
      const parallelTrace = yield* MachineTest.run(parallelMachine, { events: ["Advance", "Leave"].map(event) })
      const parallelFinal = parallelTrace.final as any
      const deepRecord = parallelFinal.history["workspace.exact"]
      const missingRegion = {
        ...parallelTrace,
        final: {
          ...parallelFinal,
          history: {
            ...parallelFinal.history,
            "workspace.exact": {
              ...deepRecord,
              active: deepRecord.active.filter((path: string) => !path.startsWith("workspace.sidebar")),
              values: Object.fromEntries(
                Object.entries(deepRecord.values).filter(([path]) => !path.startsWith("workspace.sidebar"))
              )
            }
          }
        }
      } as typeof parallelTrace
      const regionError = yield* MachineTest.verifyModel(parallelModel, missingRegion).pipe(Effect.flip)
      assert.include(fields(regionError), "trace.final.history")

      const restoredTrace = yield* MachineTest.run(deepMachine, {
        events: ["Advance", "Leave", "Resume"].map(event)
      })
      const fallback = restoredTrace.initial.startingState as any
      const fallbackAfterRecord = {
        ...restoredTrace,
        final: { ...fallback, history: (restoredTrace.final as any).history },
        finalConfiguration: ["workspace", "workspace.editor", "workspace.editor.writing"]
      } as typeof restoredTrace
      const fallbackError = yield* MachineTest.verifyModel(deepModel, fallbackAfterRecord).pipe(Effect.flip)
      assert.include(fields(fallbackError), "trace.final.activePaths")
    }))

  const generated = MachineTest.finiteModels({
    maxRoots: 3,
    maxDepth: 4,
    maxChildren: 3,
    maxEvents: 4,
    maxTransitions: 20
  }).arbitrary.chain((model) => {
    const randomEvents = FastCheck.array(FastCheck.constantFrom(...model.events), { maxLength: 20 })
    const historyScenarios = model.historyScenarios ?? []
    // Execute the generator-authored witness itself. This prevents an
    // unrelated value-bearing transition under the same owner from silently
    // standing in for the mutation that must be captured and restored.
    return FastCheck.oneof(
      ...(historyScenarios.length === 0
        ? [FastCheck.constant({ events: [] as ReadonlyArray<string>, scenario: undefined, firstUse: false })]
        : historyScenarios.map((scenario) =>
          FastCheck.constant({ events: scenario.events, scenario, firstUse: false })
        )),
      ...(historyScenarios.length === 0
        ? []
        : historyScenarios.map((scenario) =>
          FastCheck.constant({ events: [scenario.resume.event], scenario, firstUse: true })
        )),
      randomEvents.map((events) => ({ events, scenario: undefined, firstUse: false }))
    ).map(({ events, firstUse, scenario }) => ({
      model: firstUse && scenario !== undefined
        ? { ...model, initial: scenario.resume.source.split(".")[0]!, historyScenarios: [] }
        : model,
      events,
      scenario,
      firstUse
    }))
  })

  it.effect.prop(
    "stress-checks planner traces across shrinkable generated parallel/history models and scenarios",
    { generated },
    ({ generated }) => {
      const machine = MachineTest.compileModel(generated.model)
      return MachineTest.run(machine, { events: generated.events.map(event) }).pipe(
        Effect.tap((trace) => {
          if (generated.scenario === undefined) return Effect.void
          const scenario = generated.scenario
          if (generated.firstUse) {
            assert.include(trace.finalConfiguration, scenario.owner)
            assert.ok(snapshotAtPath(trace.final, scenario.history) === undefined)
            return Effect.void
          }
          const mutated = snapshotAtPath(trace.steps[0]!.after, scenario.mutation.source) as any
          const restored = snapshotAtPath(trace.final, scenario.mutation.source) as any
          assert.strictEqual(mutated.value.value, scenario.mutation.value)
          assert.strictEqual(restored.value.value, scenario.mutation.value)
          assert.strictEqual(
            (trace.final as any).history[scenario.history].values[scenario.mutation.source].value,
            scenario.mutation.value
          )
          return Effect.void
        }),
        Effect.flatMap((trace) => MachineTest.verifyModel(generated.model, trace))
      )
    },
    { timeout: 30_000, fastCheck: { numRuns: 1_500, seed: 51_205 } }
  )
})
