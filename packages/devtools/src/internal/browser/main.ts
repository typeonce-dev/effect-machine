import * as BrowserRuntime from "@effect/platform-browser/BrowserRuntime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import "./styles.css"
import * as DevToolsProtocol from "../../DevToolsProtocol.js"
import { mountMachineIndex } from "./machine-index.js"

const root = document.querySelector<HTMLDivElement>("#app")
if (root === null) throw new Error("Visualizer root element was not found")

const showConnectionFailure = (message: string): void => {
  const failure = document.createElement("div")
  failure.className = "connection-failure"
  failure.textContent = message
  root.replaceChildren(failure)
}

const connect = Effect.acquireRelease(
  Effect.sync(() => new EventSource("/api/events")),
  (events) => Effect.sync(() => events.close())
).pipe(
  Effect.flatMap((events) =>
    Effect.callback<void>((_resume, signal) => {
      events.onmessage = (event) => {
        try {
          const snapshot = Schema.decodeUnknownSync(DevToolsProtocol.RegistrySnapshot)(JSON.parse(event.data))
          mountMachineIndex(root, snapshot)
        } catch (cause) {
          showConnectionFailure(cause instanceof Error ? cause.message : String(cause))
        }
      }
      events.onerror = () => {
        if (events.readyState === EventSource.CLOSED) {
          showConnectionFailure("The visualizer server disconnected. Restart the command to reconnect.")
        }
      }
      signal.addEventListener("abort", () => events.close(), { once: true })
    })
  )
)

Effect.scoped(connect).pipe(BrowserRuntime.runMain)
