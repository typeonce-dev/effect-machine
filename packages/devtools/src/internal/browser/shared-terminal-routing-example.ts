import { Machine } from "@typeonce/effect-machine"
import { Effect, Schema } from "effect"

const ReplicationStates = Machine.state({
  initial: "Connecting",
  states: {
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
  }
})

const ReplicationEvents = Machine.eventsFromSchemas(
  Schema.TaggedUnion({
    Retry: {},
    SessionUnavailable: {},
    StopRequested: {}
  })
)

const operation = (): Effect.Effect<void, string> => Effect.succeed(undefined)

export const sharedTerminalRoutingMachine = Machine.make({
  id: "shared-terminal-routing",
  root: ReplicationStates,
  events: ReplicationEvents,
  initialConfiguration: (root) => root.resolve(({ target }) => target.from((to) => to.Connecting.from()))
}).handle({
  states: {
    Connecting: {
      invoke: (from) =>
        from.effect("connect", operation)
          .onDone((to) => to.branch.IdentifyingSource())
          .onFailure((to) => to.branch.Failed()),
      on: {
        SessionUnavailable: (to) => to.branch.SessionUnavailable(),
        StopRequested: (to) => to.branch.Stopping()
      }
    },
    IdentifyingSource: {
      invoke: (from) =>
        from.effect("identify-source", operation)
          .onDone((to) => to.branch.ReadingServerInfo())
          .onFailure((to) => to.branch.Failed()),
      on: {
        SessionUnavailable: (to) => to.branch.SessionUnavailable(),
        StopRequested: (to) => to.branch.Stopping()
      }
    },
    ReadingServerInfo: {
      invoke: (from) =>
        from.effect("read-server-info", operation)
          .onDone((to) => to.branch.ReadingSlot())
          .onFailure((to) => to.branch.Failed()),
      on: {
        SessionUnavailable: (to) => to.branch.SessionUnavailable(),
        StopRequested: (to) => to.branch.Stopping()
      }
    },
    ReadingSlot: {
      invoke: (from) =>
        from.effect("read-slot", operation)
          .onDone((to) => to.branch.CreatingSlot())
          .onFailure((to) => to.branch.Failed()),
      on: {
        SessionUnavailable: (to) => to.branch.SessionUnavailable(),
        StopRequested: (to) => to.branch.Stopping()
      }
    },
    CreatingSlot: {
      invoke: (from) =>
        from.effect("create-slot", operation)
          .onDone((to) => to.branch.CopyingSnapshot())
          .onFailure((to) => to.branch.Failed()),
      on: {
        SessionUnavailable: (to) => to.branch.SessionUnavailable(),
        StopRequested: (to) => to.branch.Stopping()
      }
    },
    CopyingSnapshot: {
      invoke: (from) =>
        from.effect("copy-snapshot", operation)
          .onDone((to) => to.branch.CatchingUp())
          .onFailure((to) => to.branch.Failed()),
      on: {
        SessionUnavailable: (to) => to.branch.SessionUnavailable(),
        StopRequested: (to) => to.branch.Stopping()
      }
    },
    CatchingUp: {
      invoke: (from) =>
        from.effect("catch-up", operation)
          .onDone((to) => to.branch.ApplyingChanges())
          .onFailure((to) => to.branch.Failed()),
      on: {
        SessionUnavailable: (to) => to.branch.SessionUnavailable(),
        StopRequested: (to) => to.branch.Stopping()
      }
    },
    ApplyingChanges: {
      invoke: (from) =>
        from.effect("apply-changes", operation)
          .onDone((to) => to.branch.Ready())
          .onFailure((to) => to.branch.Failed()),
      on: {
        SessionUnavailable: (to) => to.branch.SessionUnavailable(),
        StopRequested: (to) => to.branch.Stopping()
      }
    },
    Ready: {
      on: {
        SessionUnavailable: (to) => to.branch.SessionUnavailable(),
        StopRequested: (to) => to.branch.Stopping()
      }
    },
    SessionUnavailable: {
      on: {
        Retry: (to) => to.branch.Connecting(),
        StopRequested: (to) => to.branch.Stopping()
      }
    },
    Stopping: {
      invoke: (from) =>
        from.effect("stop-session", operation)
          .onDone((to) => to.branch.Stopped())
          .onFailure((to) => to.branch.Failed())
    },
    Stopped: {},
    Failed: {
      on: {
        Retry: (to) => to.branch.Connecting(),
        StopRequested: (to) => to.branch.Stopping()
      }
    }
  }
})
