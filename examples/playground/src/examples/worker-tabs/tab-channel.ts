import { Result, Schema } from "effect"
import type { SharedEvent } from "./machine.ts"
import { type TabMessage, TabMessageSchema } from "./protocol.ts"

const channelName = "effect-machine-example-tabs"
const decodeMessage = Schema.decodeUnknownResult(TabMessageSchema)

export function createTabChannel() {
  const channel = new BroadcastChannel(channelName)

  return {
    publishEvent: (senderId: string, event: SharedEvent) =>
      channel.postMessage(
        {
          _tag: "MachineEvent",
          senderId,
          sentAt: Date.now(),
          event
        } satisfies TabMessage
      ),
    requestSync: (requesterId: string) =>
      channel.postMessage({ _tag: "SyncRequest", requesterId, sentAt: Date.now() } satisfies TabMessage),
    publishState: (
      senderId: string,
      recipientId: string,
      state: { readonly active: boolean; readonly count: number }
    ) =>
      channel.postMessage(
        {
          _tag: "SyncState",
          senderId,
          recipientId,
          sentAt: Date.now(),
          ...state
        } satisfies TabMessage
      ),
    subscribe: (listener: (message: TabMessage) => void) => {
      const onMessage = (event: MessageEvent<unknown>) => {
        const result = decodeMessage(event.data)
        if (Result.isSuccess(result)) listener(result.success)
      }
      channel.addEventListener("message", onMessage)
      return () => channel.removeEventListener("message", onMessage)
    },
    close: () => channel.close()
  }
}
