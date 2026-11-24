import { assert, describe, it } from "@effect/vitest"
import { Cause, Clock, Duration, Effect } from "effect"
import { Machine } from "../../../src/index.js"
import * as ClusterProgress from "../../../src/internal/machine/clusterProgress.js"
import * as ClusterTimer from "../../../src/internal/machine/clusterTimer.js"
import * as ClusterWork from "../../../src/internal/machine/clusterWork.js"
import * as Configuration from "../../../src/internal/machine/configuration.js"
import * as internalMachine from "../../../src/internal/machine/machine.js"
import * as Planner from "../../../src/internal/machine/planner.js"

describe("ClusterTimer", () => {
  /** A clock whose sleeps end when the test says so. */
  const makeClock = (sleeps: ReadonlyArray<number>) => {
    let now = 1000
    const slept: Array<number> = []
    const manual: Clock.Clock = {
      currentTimeMillisUnsafe: () => now,
      currentTimeMillis: Effect.sync(() => now),
      currentTimeNanosUnsafe: () => BigInt(now),
      currentTimeNanos: Effect.sync(() => BigInt(now)),
      monotonicTimeNanosUnsafe: () => BigInt(now),
      monotonicTimeNanos: Effect.sync(() => BigInt(now)),
      sleep: (duration) =>
        Effect.sync(() => {
          now += sleeps[slept.length]!
          slept.push(Duration.toMillis(duration))
        })
    }
    return { manual, slept }
  }

  it.effect("waits until the clock has reached the due time, whatever its sleeps do", () =>
    Effect.gen(function*() {
      const waits = (dueAt: number, ...sleeps: ReadonlyArray<number>) => {
        const { manual, slept } = makeClock(sleeps)
        return Effect.as(Effect.provideService(ClusterTimer.waitUntil(dueAt), Clock.Clock, manual), slept)
      }
      assert.deepStrictEqual(yield* waits(1500, 500), [500])
      // A sleep that ends early, and a clock that is set back meanwhile.
      assert.deepStrictEqual(yield* waits(1500, 499, 1), [500, 1])
      assert.deepStrictEqual(yield* waits(1500, -200, 700), [500, 700])
      assert.deepStrictEqual(yield* waits(1500, 9000), [500])
      assert.deepStrictEqual(yield* waits(1000), [])
      assert.deepStrictEqual(yield* waits(-5), [])
    }))

  const makeMachine = (order: Array<string>) => {
    const source = (id: string, duration: () => Duration.Input) => (event: unknown): Duration.Input => {
      order.push(`${id} ${String((event as { readonly _tag: unknown })._tag)}`)
      return duration()
    }
    return Machine.make({
      root: Machine.state({
        type: "parallel",
        states: { left: { states: { Busy: {} } }, right: { states: { Busy: {} } } }
      }),
      events: Machine.events({ Go: {} }),
      effects: { effect: Effect.never },
      timers: {
        one: source("one", () => "1 second"),
        throws: source("throws", () => {
          throw new Error("no duration")
        }),
        invalid: source("invalid", () => "soon" as never),
        two: source("two", () => "2 seconds")
      }
    }).handle({
      states: {
        left: {
          initial: { target: "left.Busy" },
          states: {
            Busy: {
              invoke: [
                { src: "throws", input: ({ event }) => event, onDone: { stay: true } },
                { src: "effect" },
                { src: "two", input: ({ event }) => event, onDone: { stay: true } }
              ]
            }
          }
        },
        right: {
          invoke: [
            { src: "one", input: ({ event }) => event, onDone: { stay: true } },
            { src: "invalid", input: ({ event }) => event, onDone: { stay: true } }
          ],
          initial: { target: "right.Busy" },
          states: { Busy: {} }
        }
      }
    })
  }

  it.effect("leaves every timer with progress or unscheduled, in start order", () =>
    Effect.gen(function*() {
      const order: Array<string> = []
      const machine = makeMachine(order)
      const { state } = yield* internalMachine.planInitial(machine)
      const configuration = Configuration.normalizeConfigurationSync(machine, state)
      const schedule = (progress: ClusterProgress.Progress, now: number) =>
        ClusterTimer.schedule({
          machine,
          configuration,
          paths: Planner.sortEntryPaths(machine, Configuration.getInitialEntryPaths(machine, configuration)),
          eventOf: (path) => path === "right" ? { _tag: "Go" } : Planner.InitialEvent,
          capabilities: ClusterWork.makeCapabilities("Test", undefined),
          progress,
          now
        })
      const initial = String(Machine.InitialEvent._tag)
      const first = schedule(ClusterProgress.empty, 100)
      assert.deepStrictEqual(order, ["one Go", "invalid Go", `throws ${initial}`, `two ${initial}`])
      assert.deepStrictEqual(ClusterProgress.toStored(first.progress), {
        "right": { one: { _tag: "Waiting", dueAt: 1100 } },
        "left.Busy": { two: { _tag: "Waiting", dueAt: 2100 } }
      })
      assert.deepStrictEqual(first.unscheduled.map(({ key, stage }) => [key, stage]), [
        [{ path: "right", id: "invalid" }, "Outcome"],
        [{ path: "left.Busy", id: "throws" }, "Source"]
      ])
      assert.strictEqual((Cause.squash(first.unscheduled[1]!.cause) as Error).message, "no duration")

      // What has progress is left as it is, settled timers included.
      order.length = 0
      const kept = ClusterProgress.settle(first.progress, { path: "right", id: "one" })
      const second = schedule(kept, 9000)
      assert.strictEqual(second.progress, kept)
      assert.deepStrictEqual(order, ["invalid Go", `throws ${initial}`])
      assert.strictEqual(second.unscheduled.length, 2)
    }))
})
