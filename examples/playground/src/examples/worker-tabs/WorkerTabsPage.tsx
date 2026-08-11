import { useEffect, useRef, useState } from "react"
import { ExamplePage } from "../../components/ExamplePage.tsx"
import { type SharedEvent, SharedMachineEvent, type SharedSnapshot } from "./machine.ts"
import type { WorkerResponse } from "./protocol.ts"
import { createTabChannel } from "./tab-channel.ts"
import { createMachineWorker, type MachineWorkerClient } from "./worker-client.ts"

export function WorkerTabsPage() {
  const workerRef = useRef<MachineWorkerClient | null>(null)
  const channelRef = useRef<ReturnType<typeof createTabChannel> | null>(null)
  const snapshotRef = useRef<SharedSnapshot | null>(null)
  const tabId = useRef(crypto.randomUUID().slice(0, 8))
  const [workerStatus, setWorkerStatus] = useState("starting")
  const [tabMessage, setTabMessage] = useState("Waiting for another tab…")
  const [snapshot, setSnapshot] = useState<SharedSnapshot | null>(null)

  useEffect(() => {
    const worker = createMachineWorker()
    const channel = createTabChannel()
    workerRef.current = worker
    channelRef.current = channel

    const unsubscribeWorker = worker.subscribe((response: WorkerResponse) => {
      switch (response._tag) {
        case "Ready":
          setWorkerStatus("ready")
          break
        case "Pong":
          setWorkerStatus(`pong ${response.requestId.slice(0, 8)}`)
          break
        case "MachineSnapshot":
          snapshotRef.current = response.snapshot
          setSnapshot(response.snapshot)
          setWorkerStatus(response.lifecycle)
          break
        case "WorkerError":
          setWorkerStatus(response.message)
      }
    })

    const unsubscribeTabs = channel.subscribe((message) => {
      switch (message._tag) {
        case "MachineEvent":
          if (message.senderId !== tabId.current) {
            worker.sendEvent(message.event)
            setTabMessage(`Applied ${message.event._tag} from tab ${message.senderId}.`)
          }
          break
        case "SyncRequest": {
          const current = snapshotRef.current
          if (message.requesterId !== tabId.current && current !== null) {
            channel.publishState(tabId.current, message.requesterId, {
              active: current.path === "Active",
              count: current.value.count
            })
          }
          break
        }
        case "SyncState":
          if (message.recipientId === tabId.current) {
            worker.sendEvent(
              SharedMachineEvent.cases.Synchronized.make({ active: message.active, count: message.count })
            )
            setTabMessage(`Synchronized with tab ${message.senderId}.`)
          }
      }
    })

    channel.requestSync(tabId.current)

    return () => {
      unsubscribeWorker()
      unsubscribeTabs()
      worker.close()
      channel.close()
      workerRef.current = null
      channelRef.current = null
      snapshotRef.current = null
    }
  }, [])

  const send = (event: SharedEvent) => {
    workerRef.current?.sendEvent(event)
    channelRef.current?.publishEvent(tabId.current, event)
    setTabMessage(`Published ${event._tag} from this tab.`)
  }

  const active = snapshot?.path === "Active"
  const count = snapshot?.value.count ?? 0

  return (
    <ExamplePage
      title="Workers and tabs"
      summary="A schema-validated worker owns the machine while BroadcastChannel replicates commands and synchronizes newly opened tabs."
      machineFile="src/examples/worker-tabs/machine.ts"
    >
      <div className="worker-demo">
        <section className="worker-counter">
          <p className="machine-state-label">Worker-hosted machine</p>
          <h2>{active ? "Active" : "Idle"}</h2>
          <strong className="counter-value">{count}</strong>
          <div className="machine-controls">
            <button
              type="button"
              onClick={() =>
                send(
                  active ? SharedMachineEvent.cases.Incremented.make({}) : SharedMachineEvent.cases.Started.make({})
                )}
            >
              {active ? "Increment" : "Start"}
            </button>
            <button type="button" onClick={() => send(SharedMachineEvent.cases.Reset.make({}))}>
              Reset
            </button>
            <button
              type="button"
              disabled={!active}
              onClick={() => send(SharedMachineEvent.cases.Stopped.make({}))}
            >
              Stop
            </button>
          </div>
        </section>

        <div className="transport-grid">
          <article>
            <span className="status-dot" />
            <h2>Web Worker</h2>
            <p>{workerStatus}</p>
            <button
              type="button"
              onClick={() => workerRef.current?.send({ _tag: "Ping", requestId: crypto.randomUUID() })}
            >
              Ping worker
            </button>
          </article>
          <article>
            <span className="status-dot channel" />
            <h2>Tab {tabId.current}</h2>
            <p aria-live="polite">{tabMessage}</p>
            <button type="button" onClick={() => channelRef.current?.requestSync(tabId.current)}>
              Synchronize now
            </button>
          </article>
        </div>
      </div>
    </ExamplePage>
  )
}
