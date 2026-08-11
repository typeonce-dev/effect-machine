/// <reference lib="webworker" />

import { Machine } from "@typeonce/effect-machine"
import { Effect, Result, Schema, Stream } from "effect"
import { type SharedEvent, SharedMachine } from "./machine.ts"
import { WorkerRequestSchema, type WorkerResponse } from "./protocol.ts"

const workerScope: DedicatedWorkerGlobalScope = self as DedicatedWorkerGlobalScope
const decodeRequest = Schema.decodeUnknownResult(WorkerRequestSchema)

const post = (response: WorkerResponse) => workerScope.postMessage(response)

let deliver: ((event: SharedEvent) => void) | undefined
const pendingEvents: Array<SharedEvent> = []

const program = Effect.gen(function*() {
  const actor = yield* Machine.start(SharedMachine)
  const initial = yield* actor.snapshot

  if (initial.status === "error") {
    post({ _tag: "WorkerError", message: "The worker-hosted machine failed during startup." })
    return
  }

  post({
    _tag: "MachineSnapshot",
    lifecycle: initial.status,
    snapshot: initial.state
  })

  deliver = (event) => {
    Effect.runFork(
      actor.send(event).pipe(
        Effect.catchTag(
          "StoppedError",
          () => Effect.sync(() => post({ _tag: "WorkerError", message: "The worker-hosted machine has stopped." }))
        )
      )
    )
  }

  for (const event of pendingEvents.splice(0)) deliver(event)

  post({ _tag: "Ready" })

  yield* Stream.runForEach(actor.changes, (snapshot) =>
    Effect.sync(() => {
      if (snapshot.status === "error") {
        post({ _tag: "WorkerError", message: "The worker-hosted machine failed while processing an event." })
      } else {
        post({
          _tag: "MachineSnapshot",
          lifecycle: snapshot.status,
          snapshot: snapshot.state
        })
      }
    }))
})

Effect.runFork(program)

workerScope.addEventListener("message", (message: MessageEvent<unknown>) => {
  const request = decodeRequest(message.data)
  if (Result.isFailure(request)) {
    post({ _tag: "WorkerError", message: "Received an invalid worker request." })
    return
  }

  switch (request.success._tag) {
    case "Ping":
      post({ _tag: "Pong", requestId: request.success.requestId })
      return
    case "MachineEvent":
      if (deliver === undefined) {
        pendingEvents.push(request.success.event)
      } else {
        deliver(request.success.event)
      }
  }
})

export {}
