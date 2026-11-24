import { Effect, Option, Scope } from "effect"
import { TestClock } from "effect/testing"
import type { Machine } from "../../../../src/index.js"
import { ClusterMachine } from "../../../../src/unstable/cluster/index.js"
import { makeMessages, makeTestStorage, startRunner } from "../../../unstable/cluster/support/harness.js"
import type { Answer, Host, Outcome } from "../host.js"
import { unsupported } from "../host.js"

const answerOf = (rejected: ClusterMachine.Rejected): Answer =>
  rejected.reason === "MachineFailed" ? "Ended" : "Rejected"

// Reads the outcome as a caller of the adapter does, from the store.
const outcomeOf = (read: Option.Option<ClusterMachine.Snapshot<Machine.Machine.Any>>): Outcome => {
  if (Option.isNone(read)) return { _tag: "Running" }
  const snapshot = read.value
  switch (snapshot.status) {
    case "active":
      return { _tag: "Running" }
    case "failed":
      return { _tag: "Failed", failure: snapshot.failure }
    case "done":
      return snapshot.output === undefined ? { _tag: "Final" } : { _tag: "Final", output: snapshot.output }
  }
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
    commands: true,
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
      // An erased machine leaves the services of its schemas unknown.
      outcome: runner.client.snapshot.pipe(
        Effect.map(outcomeOf),
        Effect.provideService(ClusterMachine.Storage, storage.service),
        Effect.orDie
      ) as Effect.Effect<Outcome>,
      stop: unsupported("Stop"),
      restart: Effect.fnUntraced(function*(downtimeMillis) {
        yield* runner.stop
        yield* TestClock.adjust(downtimeMillis - startupMillis)
        runner = yield* start
      })
    }
  })
}
