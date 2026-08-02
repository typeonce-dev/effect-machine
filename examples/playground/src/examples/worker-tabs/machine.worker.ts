/// <reference lib="webworker" />

import type { WorkerRequest, WorkerResponse } from "./protocol.ts"

const workerScope: DedicatedWorkerGlobalScope = self as DedicatedWorkerGlobalScope

const post = (response: WorkerResponse) => workerScope.postMessage(response)

post({ _tag: "Ready" })

workerScope.addEventListener("message", (message: MessageEvent<WorkerRequest>) => {
  switch (message.data._tag) {
    case "Ping":
      post({ _tag: "Pong", requestId: message.data.requestId })
      return
    case "MachineEvent":
      // Plug-in point: start SharedMachine once with Machine.start, send the
      // decoded event to its ref, and publish snapshots from Machine.watch.
      post({
        _tag: "WorkerError",
        message: "Machine transport is ready; connect SharedMachine in machine.worker.ts."
      })
  }
})

export {}
