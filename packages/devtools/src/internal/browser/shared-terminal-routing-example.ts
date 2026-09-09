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

const operation: Effect.Effect<void, string> = Effect.succeed(undefined)

const targets1 = Machine.targets(ReplicationStates)
export const sharedTerminalRoutingMachine = Machine.make({
  effects: {
    source1: operation,
    source2: operation,
    source3: operation,
    source4: operation,
    source5: operation,
    source6: operation,
    source7: operation,
    source8: operation,
    source9: operation
  },

  id: "shared-terminal-routing",
  root: ReplicationStates,
  events: ReplicationEvents,
  initialConfiguration: (root) => root.resolve(({ target }) => target.from((to) => to.Connecting.from()))
}).handle({
  states: {
    Connecting: {
      invoke: {
        src: "source1",
        id: "connect",
        onDone: { target: targets1.root.IdentifyingSource },
        onFailure: { target: targets1.root.Failed }
      },
      on: {
        SessionUnavailable: { target: targets1.root.SessionUnavailable },
        StopRequested: { target: targets1.root.Stopping }
      }
    },
    IdentifyingSource: {
      invoke: {
        src: "source2",
        id: "identify-source",
        onDone: { target: targets1.root.ReadingServerInfo },
        onFailure: { target: targets1.root.Failed }
      },
      on: {
        SessionUnavailable: { target: targets1.root.SessionUnavailable },
        StopRequested: { target: targets1.root.Stopping }
      }
    },
    ReadingServerInfo: {
      invoke: {
        src: "source3",
        id: "read-server-info",
        onDone: { target: targets1.root.ReadingSlot },
        onFailure: { target: targets1.root.Failed }
      },
      on: {
        SessionUnavailable: { target: targets1.root.SessionUnavailable },
        StopRequested: { target: targets1.root.Stopping }
      }
    },
    ReadingSlot: {
      invoke: {
        src: "source4",
        id: "read-slot",
        onDone: { target: targets1.root.CreatingSlot },
        onFailure: { target: targets1.root.Failed }
      },
      on: {
        SessionUnavailable: { target: targets1.root.SessionUnavailable },
        StopRequested: { target: targets1.root.Stopping }
      }
    },
    CreatingSlot: {
      invoke: {
        src: "source5",
        id: "create-slot",
        onDone: { target: targets1.root.CopyingSnapshot },
        onFailure: { target: targets1.root.Failed }
      },
      on: {
        SessionUnavailable: { target: targets1.root.SessionUnavailable },
        StopRequested: { target: targets1.root.Stopping }
      }
    },
    CopyingSnapshot: {
      invoke: {
        src: "source6",
        id: "copy-snapshot",
        onDone: { target: targets1.root.CatchingUp },
        onFailure: { target: targets1.root.Failed }
      },
      on: {
        SessionUnavailable: { target: targets1.root.SessionUnavailable },
        StopRequested: { target: targets1.root.Stopping }
      }
    },
    CatchingUp: {
      invoke: {
        src: "source7",
        id: "catch-up",
        onDone: { target: targets1.root.ApplyingChanges },
        onFailure: { target: targets1.root.Failed }
      },
      on: {
        SessionUnavailable: { target: targets1.root.SessionUnavailable },
        StopRequested: { target: targets1.root.Stopping }
      }
    },
    ApplyingChanges: {
      invoke: {
        src: "source8",
        id: "apply-changes",
        onDone: { target: targets1.root.Ready },
        onFailure: { target: targets1.root.Failed }
      },
      on: {
        SessionUnavailable: { target: targets1.root.SessionUnavailable },
        StopRequested: { target: targets1.root.Stopping }
      }
    },
    Ready: {
      on: {
        SessionUnavailable: { target: targets1.root.SessionUnavailable },
        StopRequested: { target: targets1.root.Stopping }
      }
    },
    SessionUnavailable: {
      on: {
        Retry: { target: targets1.root.Connecting },
        StopRequested: { target: targets1.root.Stopping }
      }
    },
    Stopping: {
      invoke: {
        src: "source9",
        id: "stop-session",
        onDone: { target: targets1.root.Stopped },
        onFailure: { target: targets1.root.Failed }
      }
    },
    Stopped: {},
    Failed: {
      on: {
        Retry: { target: targets1.root.Connecting },
        StopRequested: { target: targets1.root.Stopping }
      }
    }
  }
})
