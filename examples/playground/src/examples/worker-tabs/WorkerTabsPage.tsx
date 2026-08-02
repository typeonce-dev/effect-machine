import { useEffect, useRef, useState } from "react"
import { ExamplePage, StarterPanel } from "../../components/ExamplePage.tsx"
import { SharedMachine } from "./machine.ts"
import type { WorkerResponse } from "./protocol.ts"
import { createTabChannel } from "./tab-channel.ts"
import { createMachineWorker, type MachineWorkerClient } from "./worker-client.ts"

export function WorkerTabsPage() {
  void SharedMachine

  const workerRef = useRef<MachineWorkerClient | null>(null)
  const channelRef = useRef<ReturnType<typeof createTabChannel> | null>(null)
  const tabId = useRef(crypto.randomUUID().slice(0, 8))
  const [workerStatus, setWorkerStatus] = useState("starting")
  const [tabMessage, setTabMessage] = useState("Open this route in another tab to test the channel.")

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
          setWorkerStatus("snapshot received")
          break
        case "WorkerError":
          setWorkerStatus(response.message)
      }
    })

    const unsubscribeTabs = channel.subscribe((message) => {
      setTabMessage(`Message from tab ${message.senderId} at ${new Date(message.sentAt).toLocaleTimeString()}`)
    })

    return () => {
      unsubscribeWorker()
      unsubscribeTabs()
      worker.close()
      channel.close()
      workerRef.current = null
      channelRef.current = null
    }
  }, [])

  return (
    <ExamplePage
      title="Workers and tabs"
      summary="The Vite worker entry, typed message boundary, and BroadcastChannel lifecycle are wired and ready for a machine runtime."
      machineFile="src/examples/worker-tabs/machine.ts"
    >
      <StarterPanel>
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
            <h2>Between tabs</h2>
            <p>{tabMessage}</p>
            <button
              type="button"
              onClick={() => channelRef.current?.announce(tabId.current)}
            >
              Announce this tab
            </button>
          </article>
        </div>
        <p className="implementation-note">
          Start <code>SharedMachine</code> in <code>machine.worker.ts</code>, forward public events through{` `}
          <code>MachineEvent</code>, and publish runtime snapshots through <code>MachineSnapshot</code>.
        </p>
      </StarterPanel>
    </ExamplePage>
  )
}
