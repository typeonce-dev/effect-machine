import { Effect, Scope } from "effect"
import { TestClock } from "effect/testing"
import { Machine } from "../../../../src/index.js"
import type { ClusterMachine } from "../../../../src/unstable/cluster/index.js"
import { makeMessages, makeTestStorage, startRunner } from "../../../unstable/cluster/support/harness.js"
import type { Answer, Host, Outcome } from "../host.js"
import { decode, unsupported } from "../host.js"

const answerOf = (rejected: ClusterMachine.Rejected): Answer =>
  rejected.reason === "MachineFailed" ? "Ended" : "Rejected"

const outcomeOf = (machine: Machine.Machine.Any, checkpoint: ClusterMachine.Checkpoint | undefined): Outcome => {
  if (checkpoint === undefined) return { _tag: "Running" }
  if (checkpoint.status._tag === "Failed") return { _tag: "Failed", failure: checkpoint.status.failure }
  if (!Machine.isFinal(machine as never, decode(machine, checkpoint.snapshot) as never)) return { _tag: "Running" }
  const output = checkpoint.snapshot.completed?.find(({ path }) => path === "")?.output
  return output === undefined ? { _tag: "Final" } : { _tag: "Final", output }
}

// What a runner takes to come up, as the harness starts it.
const startupMillis = 1001

/**
 * A host over `ClusterMachine`, with one runner over in-memory storages that
 * outlive it. Its states are the checkpoints it stored, and it restarts as
 * another runner.
 */
export const clusterHost: Host = {
  name: "ClusterMachine",
  capabilities: {
    invocations: ["Effect", "Timer"],
    ownedChildren: false,
    commands: false,
    restart: true,
    stop: false,
    emissions: true,
    rejection: true,
    initialState: "WithFirstEvent"
  },
  start: Effect.fnUntraced(function*({ input, machine }) {
    const scope = yield* Effect.scope
    const storage = makeTestStorage()
    const messages = yield* makeMessages
    const emitted: Array<unknown> = []
    const start = startRunner(machine, storage, messages, {
      input,
      enqueue: (event) =>
        Effect.sync(() => {
          emitted.push(event)
        })
    }).pipe(Effect.provideService(Scope.Scope, scope))
    let runner = yield* start
    return {
      get states() {
        return storage.history.map(({ snapshot }) => snapshot)
      },
      emitted,
      current: () => storage.history.at(-1)?.snapshot,
      // Sends through the client of the adapter, which takes what a local
      // reference takes.
      send: (event) =>
        runner.client.send(event as never).pipe(
          Effect.as<Answer>("Accepted"),
          Effect.catchTag("Rejected", (rejected) => Effect.succeed(answerOf(rejected))),
          Effect.orDie
        ),
      outcome: Effect.sync(() => outcomeOf(machine, runner.stored())),
      stop: unsupported("Stop"),
      restart: Effect.fnUntraced(function*(downtimeMillis) {
        yield* runner.stop
        yield* TestClock.adjust(downtimeMillis - startupMillis)
        runner = yield* start
      })
    }
  })
}
