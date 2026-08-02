import type { TabMessage } from "./protocol.ts"

const channelName = "effect-machine-example-tabs"

export function createTabChannel() {
  const channel = new BroadcastChannel(channelName)

  return {
    announce: (senderId: string) =>
      channel.postMessage({ _tag: "TabAnnouncement", senderId, sentAt: Date.now() } satisfies TabMessage),
    subscribe: (listener: (message: TabMessage) => void) => {
      const onMessage = (event: MessageEvent<TabMessage>) => listener(event.data)
      channel.addEventListener("message", onMessage)
      return () => channel.removeEventListener("message", onMessage)
    },
    close: () => channel.close()
  }
}
