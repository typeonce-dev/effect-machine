import { Machine } from "@typeonce/effect-machine"
import { Effect, Schema } from "effect"
const ReplicationStates = Machine.state({
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
const ReplicationEvents = Machine.eventsFromSchemas(Schema.TaggedUnion({
  Retry: {},
  SessionUnavailable: {},
  StopRequested: {}
}))
const operation: Effect.Effect<void, string> = Effect.succeed(undefined)
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
  events: ReplicationEvents
}).handle({
  initial: {
    target: "Connecting"
  },
  states: {
    Connecting: {
      invoke: {
        src: "source1",
        id: "connect",
        onDone: { target: "IdentifyingSource" },
        onFailure: { target: "Failed" }
      },
      on: {
        SessionUnavailable: { target: "SessionUnavailable" },
        StopRequested: { target: "Stopping" }
      }
    },
    IdentifyingSource: {
      invoke: {
        src: "source2",
        id: "identify-source",
        onDone: { target: "ReadingServerInfo" },
        onFailure: { target: "Failed" }
      },
      on: {
        SessionUnavailable: { target: "SessionUnavailable" },
        StopRequested: { target: "Stopping" }
      }
    },
    ReadingServerInfo: {
      invoke: {
        src: "source3",
        id: "read-server-info",
        onDone: { target: "ReadingSlot" },
        onFailure: { target: "Failed" }
      },
      on: {
        SessionUnavailable: { target: "SessionUnavailable" },
        StopRequested: { target: "Stopping" }
      }
    },
    ReadingSlot: {
      invoke: {
        src: "source4",
        id: "read-slot",
        onDone: { target: "CreatingSlot" },
        onFailure: { target: "Failed" }
      },
      on: {
        SessionUnavailable: { target: "SessionUnavailable" },
        StopRequested: { target: "Stopping" }
      }
    },
    CreatingSlot: {
      invoke: {
        src: "source5",
        id: "create-slot",
        onDone: { target: "CopyingSnapshot" },
        onFailure: { target: "Failed" }
      },
      on: {
        SessionUnavailable: { target: "SessionUnavailable" },
        StopRequested: { target: "Stopping" }
      }
    },
    CopyingSnapshot: {
      invoke: {
        src: "source6",
        id: "copy-snapshot",
        onDone: { target: "CatchingUp" },
        onFailure: { target: "Failed" }
      },
      on: {
        SessionUnavailable: { target: "SessionUnavailable" },
        StopRequested: { target: "Stopping" }
      }
    },
    CatchingUp: {
      invoke: {
        src: "source7",
        id: "catch-up",
        onDone: { target: "ApplyingChanges" },
        onFailure: { target: "Failed" }
      },
      on: {
        SessionUnavailable: { target: "SessionUnavailable" },
        StopRequested: { target: "Stopping" }
      }
    },
    ApplyingChanges: {
      invoke: {
        src: "source8",
        id: "apply-changes",
        onDone: { target: "Ready" },
        onFailure: { target: "Failed" }
      },
      on: {
        SessionUnavailable: { target: "SessionUnavailable" },
        StopRequested: { target: "Stopping" }
      }
    },
    Ready: {
      on: {
        SessionUnavailable: { target: "SessionUnavailable" },
        StopRequested: { target: "Stopping" }
      }
    },
    SessionUnavailable: {
      on: {
        Retry: { target: "Connecting" },
        StopRequested: { target: "Stopping" }
      }
    },
    Stopping: {
      invoke: {
        src: "source9",
        id: "stop-session",
        onDone: { target: "Stopped" },
        onFailure: { target: "Failed" }
      }
    },
    Stopped: {},
    Failed: {
      on: {
        Retry: { target: "Connecting" },
        StopRequested: { target: "Stopping" }
      }
    }
  }
})
