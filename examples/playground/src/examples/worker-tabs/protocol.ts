import { Schema } from "effect"
import { SharedMachineEvent, type SharedSnapshot } from "./machine.ts"

export const WorkerRequestSchema = Schema.TaggedUnion({
  Ping: { requestId: Schema.String },
  MachineEvent: { event: SharedMachineEvent }
})

export type WorkerRequest = typeof WorkerRequestSchema.Type

export type WorkerResponse =
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Pong"; readonly requestId: string }
  | {
    readonly _tag: "MachineSnapshot"
    readonly lifecycle: "active" | "done" | "stopped"
    readonly snapshot: SharedSnapshot
  }
  | { readonly _tag: "WorkerError"; readonly message: string }

export const TabMessageSchema = Schema.TaggedUnion({
  MachineEvent: {
    senderId: Schema.String,
    sentAt: Schema.Number,
    event: SharedMachineEvent
  },
  SyncRequest: {
    requesterId: Schema.String,
    sentAt: Schema.Number
  },
  SyncState: {
    senderId: Schema.String,
    recipientId: Schema.String,
    sentAt: Schema.Number,
    active: Schema.Boolean,
    count: Schema.Number
  }
})

export type TabMessage = typeof TabMessageSchema.Type
