import type { WorkerRequest, WorkerResponse } from "./protocol.ts"

export function createMachineWorker() {
  const worker = new Worker(new URL("./machine.worker.ts", import.meta.url), {
    type: "module",
    name: "effect-machine-example"
  })

  return {
    worker,
    send: (request: WorkerRequest) => worker.postMessage(request),
    subscribe: (listener: (response: WorkerResponse) => void) => {
      const onMessage = (event: MessageEvent<WorkerResponse>) => listener(event.data)
      worker.addEventListener("message", onMessage)
      return () => worker.removeEventListener("message", onMessage)
    },
    close: () => worker.terminate()
  }
}

export type MachineWorkerClient = ReturnType<typeof createMachineWorker>
