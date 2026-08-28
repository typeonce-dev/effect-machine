import { Machine } from "@typeonce/effect-machine"
import { Effect, Schema } from "effect"

const ReplicationStates = Machine.states({
  Connecting: {},
  IdentifyingSource: {},
  ReadingServerInfo: {},
  ReadingSlot: {},
  CreatingSlot: {},
  CopyingSnapshot: {},
  CatchingUp: {},
  ApplyingChanges: {},
  Ready: {},
  SessionUnavailable: {},
  Stopping: {},
  Stopped: {},
  Failed: {}
})

const ReplicationEvents = Machine.events(
  Schema.TaggedUnion({
    Retry: {},
    SessionUnavailable: {},
    StopRequested: {}
  })
)

const operation = (): Effect.Effect<void, string> => Effect.succeed(undefined)

export const sharedTerminalRoutingMachine = Machine.make({
  id: "shared-terminal-routing",
  states: ReplicationStates.states,
  events: ReplicationEvents,
  initial: (to) => to.Connecting()
}).handle({
  Connecting: {
    invoke: (from) =>
      from.effect("connect", operation)
        .onDone((to) => to.full.IdentifyingSource())
        .onFailure((to) => to.full.Failed()),
    on: {
      SessionUnavailable: (to) => to.full.SessionUnavailable(),
      StopRequested: (to) => to.full.Stopping()
    }
  },
  IdentifyingSource: {
    invoke: (from) =>
      from.effect("identify-source", operation)
        .onDone((to) => to.full.ReadingServerInfo())
        .onFailure((to) => to.full.Failed()),
    on: {
      SessionUnavailable: (to) => to.full.SessionUnavailable(),
      StopRequested: (to) => to.full.Stopping()
    }
  },
  ReadingServerInfo: {
    invoke: (from) =>
      from.effect("read-server-info", operation)
        .onDone((to) => to.full.ReadingSlot())
        .onFailure((to) => to.full.Failed()),
    on: {
      SessionUnavailable: (to) => to.full.SessionUnavailable(),
      StopRequested: (to) => to.full.Stopping()
    }
  },
  ReadingSlot: {
    invoke: (from) =>
      from.effect("read-slot", operation)
        .onDone((to) => to.full.CreatingSlot())
        .onFailure((to) => to.full.Failed()),
    on: {
      SessionUnavailable: (to) => to.full.SessionUnavailable(),
      StopRequested: (to) => to.full.Stopping()
    }
  },
  CreatingSlot: {
    invoke: (from) =>
      from.effect("create-slot", operation)
        .onDone((to) => to.full.CopyingSnapshot())
        .onFailure((to) => to.full.Failed()),
    on: {
      SessionUnavailable: (to) => to.full.SessionUnavailable(),
      StopRequested: (to) => to.full.Stopping()
    }
  },
  CopyingSnapshot: {
    invoke: (from) =>
      from.effect("copy-snapshot", operation)
        .onDone((to) => to.full.CatchingUp())
        .onFailure((to) => to.full.Failed()),
    on: {
      SessionUnavailable: (to) => to.full.SessionUnavailable(),
      StopRequested: (to) => to.full.Stopping()
    }
  },
  CatchingUp: {
    invoke: (from) =>
      from.effect("catch-up", operation)
        .onDone((to) => to.full.ApplyingChanges())
        .onFailure((to) => to.full.Failed()),
    on: {
      SessionUnavailable: (to) => to.full.SessionUnavailable(),
      StopRequested: (to) => to.full.Stopping()
    }
  },
  ApplyingChanges: {
    invoke: (from) =>
      from.effect("apply-changes", operation)
        .onDone((to) => to.full.Ready())
        .onFailure((to) => to.full.Failed()),
    on: {
      SessionUnavailable: (to) => to.full.SessionUnavailable(),
      StopRequested: (to) => to.full.Stopping()
    }
  },
  Ready: {
    on: {
      SessionUnavailable: (to) => to.full.SessionUnavailable(),
      StopRequested: (to) => to.full.Stopping()
    }
  },
  SessionUnavailable: {
    on: {
      Retry: (to) => to.full.Connecting(),
      StopRequested: (to) => to.full.Stopping()
    }
  },
  Stopping: {
    invoke: (from) =>
      from.effect("stop-session", operation)
        .onDone((to) => to.full.Stopped())
        .onFailure((to) => to.full.Failed())
  },
  Stopped: {},
  Failed: {
    on: {
      Retry: (to) => to.full.Connecting(),
      StopRequested: (to) => to.full.Stopping()
    }
  }
})
