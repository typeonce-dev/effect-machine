export type WorkerRequest =
  | { readonly _tag: "Ping"; readonly requestId: string }
  | { readonly _tag: "MachineEvent"; readonly event: unknown }

export type WorkerResponse =
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Pong"; readonly requestId: string }
  | { readonly _tag: "MachineSnapshot"; readonly snapshot: unknown }
  | { readonly _tag: "WorkerError"; readonly message: string }

export type TabMessage = {
  readonly _tag: "TabAnnouncement"
  readonly senderId: string
  readonly sentAt: number
}
