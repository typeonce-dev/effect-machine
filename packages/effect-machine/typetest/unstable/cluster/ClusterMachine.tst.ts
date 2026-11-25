import { Context, Effect, type Layer, type Option, Schedule, Schema, SchemaGetter, type Stream } from "effect"
import type { ClusterError, EntityId, MessageStorage, Sharding, Snowflake } from "effect/cluster"
import type { Rpc, RpcGroup } from "effect/rpc"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../../src/index.js"
import { ClusterMachine } from "../../../src/unstable/cluster/index.js"
describe("ClusterMachine", () => {
  it("preserves the public checkpoint and wire-schema contracts", () => {
    expect(ClusterMachine.CommitResult.Committed()).type.toBe<ClusterMachine.CommitResult.Committed>()
    expect(ClusterMachine.CommitResult.Duplicate()).type.toBe<ClusterMachine.CommitResult.Duplicate>()
    expect(ClusterMachine.CommitResult.RevisionConflict()).type.toBe<ClusterMachine.CommitResult.RevisionConflict>()
    expect<ClusterMachine.CommitResult["_tag"]>().type.toBe<"Committed" | "Duplicate" | "RevisionConflict">()
    expect<ClusterMachine.Checkpoint["revision"]>().type.toBe<number>()
    expect<Schema.Schema.Type<typeof ClusterMachine.SendResult>>().type.toBe<
      ClusterMachine.Accepted | ClusterMachine.Rejected
    >()
    expect<Schema.Schema.Type<typeof ClusterMachine.RejectionReason>>().type.toBe<
      | "InvalidEvent"
      | "DefinitionIdMismatch"
      | "VersionMismatch"
      | "InvalidCheckpoint"
      | "UnsupportedProcessLocal"
      | "TransitionFailure"
      | "SnapshotEncodeFailure"
      | "PersistenceFailure"
      | "RevisionConflict"
      | "EmissionFailure"
      | "MachineFailed"
    >()
  })
  it("identifies a request only for a checkpoint that came from one", () => {
    expect<ClusterMachine.Checkpoint["origin"]>().type.toBe<
      | ClusterMachine.Checkpoint.Origin.Request
      | ClusterMachine.Checkpoint.Origin.Invocation
      | ClusterMachine.Checkpoint.Origin.Timers
    >()
    expect<Extract<ClusterMachine.Checkpoint.Origin, { readonly _tag: "Request" }>["requestId"]>().type.toBe<
      Snowflake.Snowflake
    >()
    expect<ClusterMachine.Checkpoint.Origin.Invocation>().type.not.toHaveProperty("requestId")
    expect<ClusterMachine.Checkpoint.Origin.Timers>().type.not.toHaveProperty("requestId")
    expect<ClusterMachine.Checkpoint.Origin.Timers>().type.not.toHaveProperty("path")
    type Service = ClusterMachine.Storage["Service"]
    expect<Parameters<Service["load"]>["length"]>().type.toBe<1>()
    expect<Effect.Success<ReturnType<Service["load"]>>>().type.toBe<Option.Option<ClusterMachine.Checkpoint>>()
    expect<Parameters<Service["loadForRequest"]>[1]>().type.toBe<Snowflake.Snowflake>()
    expect<Effect.Success<ReturnType<Service["loadForRequest"]>>>().type.toBe<ClusterMachine.LoadResult>()
  })
  it("keeps the parts of an active and of a failed status apart", () => {
    expect<ClusterMachine.Checkpoint["status"]["_tag"]>().type.toBe<"Active" | "Failed" | "Stopped">()
    expect<ClusterMachine.Checkpoint.Status.Active>().type.not.toHaveProperty("failure")
    expect<ClusterMachine.Checkpoint.Status.Failed>().type.not.toHaveProperty("invocations")
    expect<{ readonly _tag: "Active"; readonly invocations: {}; readonly failure: string }>().type.not
      .toBe<ClusterMachine.Checkpoint.Status>()
    expect<{ readonly _tag: "Failed" }>().type.not.toBeAssignableTo<ClusterMachine.Checkpoint.Status>()
  })
  it("gives an invocation one progress, and only a waiting timer a due time", () => {
    type Invocations = ClusterMachine.Checkpoint.Invocations
    expect<Invocations[string][string]["_tag"]>().type.toBe<"Settled" | "Waiting" | "Child">()
    expect<ClusterMachine.Checkpoint.Progress.Child["entityId"]>().type.toBe<string>()
    expect<ClusterMachine.Checkpoint.Progress.Settled>().type.not.toHaveProperty("dueAt")
    expect<ClusterMachine.Checkpoint.Progress.Waiting["dueAt"]>().type.toBe<number>()
    expect<{ readonly _tag: "Waiting" }>().type.not.toBeAssignableTo<ClusterMachine.Checkpoint.Progress>()
  })
  class Count extends Schema.TaggedClass<Count>("Count")("Count", {
    value: Schema.Number
  }) {
  }
  class Increment extends Schema.TaggedClass<Increment>("Increment")("Increment", {
    by: Schema.Number
  }) {
  }
  class Reset extends Schema.TaggedClass<Reset>("Reset")("Reset", {}) {
  }
  class Done extends Schema.TaggedClass<Done>("Done")("Done", {
    value: Schema.String
  }) {
  }
  class Input extends Schema.Class<Input>("Input")({
    value: Schema.Number
  }) {
  }
  interface LocalResource {
    readonly close: () => void
  }
  const LocalResource = Schema.declare<LocalResource>((value): value is LocalResource =>
    typeof value === "object" && value !== null && "close" in value && typeof value.close === "function"
  )
  class ResourceState extends Schema.TaggedClass<ResourceState>("ResourceState")("ResourceState", {
    resource: LocalResource
  }) {
  }
  class ResourceEvent extends Schema.TaggedClass<ResourceEvent>("ResourceEvent")("ResourceEvent", {
    resource: LocalResource
  }) {
  }
  class UnknownEvent extends Schema.TaggedClass<UnknownEvent>("UnknownEvent")("UnknownEvent", {
    payload: Schema.Unknown
  }) {
  }
  class Scheduled extends Schema.TaggedClass<Scheduled>("Scheduled")("Scheduled", {
    at: Schema.Date
  }) {
  }
  class PlanningService extends Context.Service<PlanningService, {
    readonly value: number
  }>()("test/ClusterMachine/PlanningService") {
  }
  class ActionService extends Context.Service<ActionService, {
    readonly run: Effect.Effect<void>
  }>()("test/ClusterMachine/ActionService") {
  }
  class SnapshotDecoding extends Context.Service<SnapshotDecoding, number>()("test/ClusterMachine/SnapshotDecoding") {
  }
  class SnapshotEncoding extends Context.Service<SnapshotEncoding, number>()("test/ClusterMachine/SnapshotEncoding") {
  }
  const states = Machine.state({
    states: { Count }
  })
  const machine = Machine.make({
    id: "Counter",
    root: states,
    events: Machine.eventsFromSchemas(Increment, Reset)
  }).handle({
    initial: {
      target: "Count",
      decoded: true,
      data: new Count({ value: 0 })
    },
    states: {
      Count: {
        on: {
          Increment: {
            target: "Count",
            decoded: true,
            data: ({ event, state }) => (new Count({ value: state.value + event.by }))
          },
          Reset: { target: "Count", decoded: true, data: () => (new Count({ value: 0 })) }
        }
      }
    }
  })
  const bridge = ClusterMachine.make("CounterEntity", machine, { version: "1" })
  it("preserves the machine event union in the send RPC", () => {
    type Rpcs = RpcGroup.Rpcs<typeof bridge.entity.protocol>
    expect<Rpc.Payload<Rpcs>>().type.toBe<Increment | Reset>()
    expect<Rpc.Success<Rpcs>>().type.toBe<ClusterMachine.Accepted | ClusterMachine.Rejected>()
    const internalMachine = Machine.make({
      root: states,
      events: Machine.eventsFromSchemas(Increment),
      internalEvents: Machine.internalEventsFromSchemas(Reset)
    }).handle({
      initial: {
        target: "Count",
        decoded: true,
        data: new Count({ value: 0 })
      },
      states: { Count: {} }
    })
    const internalBridge = ClusterMachine.make("InternalCounterEntity", internalMachine, {
      version: "1"
    })
    type InternalRpcs = RpcGroup.Rpcs<typeof internalBridge.entity.protocol>
    expect<Rpc.Payload<InternalRpcs>>().type.toBe<Increment>()
  })
  it("retains Cluster service requirements", () => {
    const layer = bridge.toLayer()
    expect<Layer.Services<typeof layer>>().type.toBe<
      ClusterMachine.Storage | MessageStorage.MessageStorage | Sharding.Sharding
    >()
  })
  it("requires the services of invoked effects", () => {
    const invoking = Machine.make({
      id: "Invoking",
      root: states,
      events: Machine.eventsFromSchemas(Reset),
      effects: { work: Effect.map(PlanningService, ({ value }) => value) }
    }).handle({
      initial: { target: "Count", decoded: true, data: new Count({ value: 0 }) },
      states: { Count: { invoke: { src: "work", onDone: { stay: true } } } }
    })
    const layer = ClusterMachine.make("Invoking", invoking, { version: "1" }).toLayer()
    expect<Layer.Services<typeof layer>>().type.toBe<
      ClusterMachine.Storage | MessageStorage.MessageStorage | Sharding.Sharding | PlanningService
    >()
  })
  it("supports per-entity and default non-void machine input, and checks JSON-encoded input schemas", () => {
    const inputStates = Machine.state({ fields: { input: Input }, states: { Count } })
    const inputMachine = Machine.make({
      id: "InputCounter",
      root: inputStates,
      events: Machine.eventsFromSchemas(Reset),
      input: Input
    }).handle({
      initial: {
        target: "Count",
        decoded: true,
        data: ({ root: { input } }) => new Count({ value: input.value })
      },
      root: ({ input }) => ({ input }),
      states: { Count: {} }
    })
    expect(ClusterMachine.make).type.toBeCallableWith("InputCounterEntity", inputMachine, { version: "1" })
    expect(ClusterMachine.make).type.toBeCallableWith(
      "InputCounterEntity",
      inputMachine,
      { version: "1" },
      new Input({ value: 1 })
    )
    expect(ClusterMachine.make).type.not.toBeCallableWith(
      "InputCounterEntity",
      inputMachine,
      { version: "1" },
      "not-an-input"
    )
    const inputAdapter = ClusterMachine.make("InputCounterEntity", inputMachine, { version: "1" })
    const inputClient = null! as Effect.Success<typeof inputAdapter.client> extends (id: string) => infer C ? C : never
    expect(inputClient.start).type.toBeCallableWith(new Input({ value: 1 }))
    expect(inputClient.start).type.not.toBeCallableWith()
    expect(inputClient.start).type.not.toBeCallableWith("not-an-input")

    const noInputClient = null! as Effect.Success<typeof bridge.client> extends (id: string) => infer C ? C : never
    expect(noInputClient.start).type.toBeCallableWith()
    expect(noInputClient.start).type.not.toBeCallableWith(1)

    const resourceInputMachine = Machine.make({
      id: "ResourceInputCounter",
      root: states,
      events: Machine.eventsFromSchemas(Reset),
      input: LocalResource
    }).handle({
      initial: { target: "Count", decoded: true, data: new Count({ value: 0 }) },
      states: { Count: {} }
    })
    expect(ClusterMachine.make).type.not.toBeCallableWith(
      "ResourceInputEntity",
      resourceInputMachine,
      { version: "1" }
    )
  })
  it("uses encoded Machine snapshots in checkpoints", () => {
    expect<ClusterMachine.Checkpoint["snapshot"]>().type.toBe<Machine.Machine.EncodedSnapshot>()
    expect<Machine.Machine.EncodedSnapshotState["value"]>().type.toBe<Schema.Json | undefined>()
    expect<Machine.Machine.EncodedSnapshotCompletion["output"]>().type.toBe<Schema.Json | undefined>()
    expect<Machine.Machine.EncodedSnapshotHistoryEntry["values"]>().type.toBe<Readonly<Record<string, Schema.Json>>>()
  })
  it("requires JSON-encoded state, output, and public input schemas", () => {
    const resourceStates = Machine.state({ states: { ResourceState } })
    const resourceMachine = Machine.make({
      root: resourceStates,
      events: Machine.eventsFromSchemas(ResourceEvent)
    }).handle({
      initial: {
        target: "ResourceState",
        decoded: true,
        data: new ResourceState({ resource: { close() {} } })
      },
      states: { ResourceState: {} }
    })
    expect(ClusterMachine.make).type.not.toBeCallableWith("ResourceEntity", resourceMachine, { version: "1" })
    const unknownEventMachine = Machine.make({
      root: states,
      events: Machine.eventsFromSchemas(UnknownEvent)
    }).handle({
      initial: {
        target: "Count",
        decoded: true,
        data: new Count({ value: 0 })
      },
      states: { Count: {} }
    })
    expect(ClusterMachine.make).type.not.toBeCallableWith("UnknownEventEntity", unknownEventMachine, { version: "1" })
    const anyOutputStates = Machine.state({
      states: {
        Done: { schema: Done, type: "final", output: Schema.Any }
      }
    })
    const anyOutputMachine = Machine.make({
      root: anyOutputStates,
      events: Machine.eventsFromSchemas(Reset)
    }).handle({
      initial: {
        target: "Done",
        decoded: true,
        data: new Done({ value: "done" })
      },
      states: { Done: { output: () => null } }
    })
    expect(ClusterMachine.make).type.not.toBeCallableWith("AnyOutputEntity", anyOutputMachine, { version: "1" })
    const neverOutputStates = Machine.state({
      states: {
        Done: { schema: Done, type: "final", output: Schema.Never }
      }
    })
    const neverOutputMachine = Machine.make({
      root: neverOutputStates,
      events: Machine.eventsFromSchemas(Reset)
    }).handle({
      initial: {
        target: "Done",
        decoded: true,
        data: new Done({ value: "done" })
      },
      states: {
        Done: {
          output: () => {
            throw new Error("unreachable")
          }
        }
      }
    })
    expect(ClusterMachine.make).type.not.toBeCallableWith("NeverOutputEntity", neverOutputMachine, { version: "1" })
    const scheduledStates = Machine.state({
      states: { Scheduled: Schema.toCodecJson(Scheduled) }
    })
    const scheduledMachine = Machine.make({
      root: scheduledStates,
      events: Machine.eventsFromSchemas(Reset)
    }).handle({
      initial: {
        target: "Scheduled",
        decoded: true,
        data: new Scheduled({ at: new Date("2026-08-19") })
      },
      states: { Scheduled: {} }
    })
    expect(ClusterMachine.make).type.toBeCallableWith("ScheduledEntity", scheduledMachine, { version: "1" })
    const internalResourceMachine = Machine.make({
      root: states,
      events: Machine.eventsFromSchemas(Reset),
      internalEvents: Machine.internalEventsFromSchemas(ResourceEvent)
    }).handle({
      initial: {
        target: "Count",
        decoded: true,
        data: new Count({ value: 0 })
      },
      states: { Count: {} }
    })
    expect(ClusterMachine.make).type.toBeCallableWith("InternalResourceEntity", internalResourceMachine, {
      version: "1"
    })
  })
  it("requires declared output implementations", () => {
    const outputStates = Machine.state({
      states: {
        Done: {
          schema: Done,
          type: "final",
          output: Schema.String
        }
      }
    })
    const incomplete = Machine.make({
      root: outputStates,
      events: Machine.eventsFromSchemas(Reset)
    })
    expect(ClusterMachine.make).type.not.toBeCallableWith("Incomplete", incomplete, { version: "1" })
    const complete = incomplete.handle({
      initial: {
        target: "Done",
        decoded: true,
        data: new Done({ value: "done" })
      },
      states: { Done: { output: ({ state }) => state.value } }
    })
    expect(ClusterMachine.make).type.toBeCallableWith("Complete", complete, { version: "1" })
  })
  it("retains snapshot codec service requirements", () => {
    const ContextualNumber = Schema.Number.pipe(
      Schema.decode({
        decode: SchemaGetter.transformEffect((value) => Effect.as(SnapshotDecoding, value)),
        encode: SchemaGetter.passthrough()
      }),
      Schema.encode({
        decode: SchemaGetter.passthrough(),
        encode: SchemaGetter.transformEffect((value) => Effect.as(SnapshotEncoding, value))
      })
    )
    class ContextualCount extends Schema.TaggedClass<ContextualCount>("ContextualCount")("ContextualCount", {
      value: ContextualNumber
    }) {
    }
    const contextualStates = Machine.state({ states: { ContextualCount } })
    const contextualMachine = Machine.make({
      root: contextualStates,
      events: Machine.eventsFromSchemas(Reset)
    }).handle({
      initial: {
        target: "ContextualCount",
        decoded: true,
        data: new ContextualCount({ value: 0 })
      },
      states: { ContextualCount: {} }
    })
    const layer = ClusterMachine.make("ContextualCounter", contextualMachine, { version: "1" }).toLayer()
    expect<Layer.Services<typeof layer>>().type.toBe<
      ClusterMachine.Storage | MessageStorage.MessageStorage | Sharding.Sharding | SnapshotDecoding | SnapshotEncoding
    >()
  })
  it("gives a client that takes what a local reference takes, and fails with a rejection", () => {
    const Events = Machine.events({ Rename: { name: Schema.String }, Archive: {} })
    const machine = Machine.make({
      root: Machine.state({ states: { Draft: {} } }),
      events: Events,
      internalEvents: Machine.internalEvents({ Touched: {} })
    }).handle({
      initial: { target: "Draft" },
      states: { Draft: { on: { Rename: { stay: true }, Archive: { stay: true }, Touched: { stay: true } } } }
    })
    const adapter = ClusterMachine.make("Document", machine, { version: "1" })
    expect<Effect.Services<typeof adapter.client>>().type.toBe<Sharding.Sharding>()
    const client = null! as Effect.Success<typeof adapter.client> extends (id: string) => infer C ? C : never
    expect(client).type.toBe<ClusterMachine.Client<typeof machine>>()
    expect(client.send).type.toBeCallableWith(Events.Rename({ name: "report" }))
    expect(client.send).type.toBeCallableWith({ _tag: "Rename" as const, name: "report" })
    expect(client.send).type.toBeCallableWith(Events.Archive())
    expect(client.send).type.not.toBeCallableWith({ _tag: "Touched" as const })
    expect(client.send).type.not.toBeCallableWith({ _tag: "Rename" as const, name: 1 })
    expect<Effect.Error<ReturnType<typeof client.send>>>().type.toBe<
      ClusterMachine.Rejected | ClusterMachine.ClientError
    >()
    expect<Effect.Services<ReturnType<typeof client.send>>>().type.toBe<never>()
  })

  it("reads a typed snapshot and output from the store", () => {
    const Events = Machine.events({ Finish: {} })
    const machine = Machine.make({
      root: Machine.state({
        states: {
          Working: { fields: { step: Schema.Number } },
          Done: { type: "final", output: Schema.String }
        }
      }),
      events: Events
    }).handle({
      initial: { target: "Working", data: { step: 0 } },
      states: { Working: { on: { Finish: { target: "Done" } } }, Done: { output: () => "finished" } }
    })
    const adapter = ClusterMachine.make("Job", machine, { version: "1", readInterval: "5 seconds" })
    const client = null! as Effect.Success<typeof adapter.client> extends (id: string) => infer C ? C : never
    type Read = ClusterMachine.Snapshot<typeof machine>

    expect<Effect.Success<typeof client.snapshot>>().type.toBe<Option.Option<Read>>()
    expect<Effect.Error<typeof client.snapshot>>().type.toBe<
      ClusterMachine.ReadError | ClusterError.PersistenceError
    >()
    expect<Effect.Services<typeof client.snapshot>>().type.toBe<ClusterMachine.Storage>()
    expect<Stream.Success<typeof client.changes>>().type.toBe<Read>()
    expect<Effect.Success<typeof client.join>>().type.toBe<string>()
    expect<Effect.Error<typeof client.join>>().type.toBe<
      ClusterMachine.MachineFailedError | ClusterMachine.ReadError | ClusterError.PersistenceError
    >()
    expect<Extract<Read, { readonly status: "done" }>["output"]>().type.toBe<string>()
    expect<Extract<Read, { readonly status: "failed" }>["failure"]>().type.toBe<string>()
    expect<Read["status"]>().type.toBe<"active" | "done" | "failed" | "stopped">()
  })

  it("names a Cluster machine as a target that checks the events sent to it", () => {
    const Ledger = ClusterMachine.make(
      "Ledger",
      Machine.make({
        root: Machine.state({ states: { Open: {} } }),
        events: Machine.events({ Add: { amount: Schema.Number } })
      }).handle({ initial: { target: "Open" } }),
      { version: "1" }
    )
    const target = Ledger.target("ledger-1")
    expect(target).type.toBeAssignableTo<ClusterMachine.Target<{ readonly _tag: "Add"; readonly amount: number }>>()
    expect(target).type.toBeAssignableTo<Machine.MachineTarget<{ readonly _tag: "Add"; readonly amount: number }>>()
    expect<Machine.MachineTarget<unknown>>().type.not.toBeAssignableTo<ClusterMachine.Target<unknown>>()

    const order = (commands: (enqueue: Machine.Commands<any, never>) => void) =>
      Machine.make({
        root: Machine.state({ states: { Open: {}, Paid: {} } }),
        events: Machine.events({ Pay: {} })
      }).handle({
        initial: { target: "Open" },
        states: { Open: { on: { Pay: { target: "Paid", commands: (_, enqueue) => commands(enqueue) } } }, Paid: {} }
      })
    expect(order((enqueue) => enqueue.sendTo(target, { _tag: "Add", amount: 1 }))).type.not.toRaiseError()
    expect(order((enqueue) => enqueue.sendTo(target, { _tag: "Remove", amount: 1 }))).type.toRaiseError()
    expect(order((enqueue) => enqueue.sendTo(target, { _tag: "Add", amount: "1" }))).type.toRaiseError()
    expect(order((enqueue) => enqueue.stop(target))).type.toRaiseError()
  })

  it("supports shardGroup, Entity.toLayer tuning options, and transactional onCommit with typed services", () => {
    const sharded = ClusterMachine.make("ShardedCounter", machine, {
      version: "1",
      shardGroup: (entityId: EntityId.EntityId) => entityId.startsWith("eu:") ? "eu" : "us"
    })
    expect(sharded).type.toBeAssignableTo<ClusterMachine.ClusterMachine<"ShardedCounter", typeof machine>>()

    const layer = sharded.toLayer({
      enqueue: () => Effect.asVoid(PlanningService),
      onCommit: (event) => {
        expect(event).type.toBe<ClusterMachine.CommitEvent<typeof machine>>()
        expect(event.entityId).type.toBe<string>()
        expect(event.checkpoint).type.toBe<ClusterMachine.Checkpoint>()
        expect(event.snapshot).type.toBe<ClusterMachine.Snapshot<typeof machine>>()
        return Effect.flatMap(ActionService, (service) => service.run)
      },
      maxIdleTime: "30 seconds",
      concurrency: 1,
      mailboxCapacity: 64,
      mailboxMetrics: true,
      disableFatalDefects: false,
      defectRetryPolicy: Schedule.spaced("1 second"),
      spanAttributes: { region: "eu" }
    })
    expect<Layer.Services<typeof layer>>().type.toBe<
      ClusterMachine.Storage | MessageStorage.MessageStorage | Sharding.Sharding | PlanningService | ActionService
    >()
  })
})
