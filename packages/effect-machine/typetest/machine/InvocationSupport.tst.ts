import { type Effect, type Layer, type Scope, Stream } from "effect"
import type { MessageStorage, Sharding } from "effect/cluster"
import type { Atom } from "effect/reactivity"
import { describe, expect, it } from "tstyche"
import { LocalMachine, Machine } from "../../src/index.js"
import { ClusterMachine } from "../../src/unstable/cluster/index.js"
import { AtomMachine } from "../../src/unstable/reactivity/index.js"
import type { Rebuilt } from "../support/rebuilt.js"

declare const service: unique symbol
interface Database {
  readonly [service]: "Database"
}
interface Feed {
  readonly [service]: "Feed"
}
interface Worker {
  readonly [service]: "Worker"
}

const root = Machine.state({ states: { Idle: {}, Busy: {} } })
const events = Machine.events({ Start: {} })
const address = Machine.childAddress<never>("worker")

const quiet = Machine.make({ root, events }).handle({ initial: { target: "Idle" } })
const streamingChild = Machine.make({ root, events, streams: { feed: Stream.make(1) } }).handle({
  initial: { target: "Idle" },
  states: { Busy: { invoke: { src: "feed", onElement: { stay: true }, onDone: { stay: true } } } }
})
const sendingChild = Machine.make({ root, events, effects: { stop: Machine.stopChild(address) } }).handle({
  initial: { target: "Idle" },
  states: { Busy: { invoke: { src: "stop", onDone: { stay: true } } } }
})
const grandparent = Machine.make({
  root,
  events,
  children: { streaming: Machine.child("streaming", streamingChild) }
}).handle({ initial: { target: "Idle" }, states: { Busy: { invoke: { src: "streaming" } } } })

const initial = { target: "Idle" } as const
const definition = Machine.make({
  root,
  events,
  effects: {
    load: null! as Effect.Effect<number, never, Database>,
    stop: Machine.stopChild(address),
    stopStored: null! as Effect.Effect<void, never, Machine.MachineRuntime | Database>
  },
  timers: { wait: "1 second" },
  streams: {
    feed: null! as Stream.Stream<number, never, Feed>,
    stopping: Stream.fromEffect(Machine.stopChild(address))
  },
  logic: {
    worker: null! as Machine.Logic<number, never, never, Worker, void>,
    spawning: null! as Machine.Logic<number, never, never, Machine.MachineRuntime, void>
  },
  children: {
    quiet: Machine.child("quiet", quiet),
    streaming: Machine.child("streaming", streamingChild),
    sending: Machine.child("sending", sendingChild),
    grandparent: Machine.child("grandparent", grandparent)
  }
})

const handled = definition.handle({ initial })
const hosted = definition.handle({
  initial,
  states: {
    Busy: {
      invoke: [
        { src: "load", onDone: { stay: true } },
        { src: "wait", onDone: { stay: true } }
      ]
    }
  }
})
const timed = definition.handle({ initial, states: { Busy: { invoke: { src: "wait", onDone: { stay: true } } } } })
const streaming = definition.handle({
  initial,
  states: { Busy: { invoke: { src: "feed", onElement: { stay: true }, onDone: { stay: true } } } }
})
const working = definition.handle({
  initial,
  states: { Busy: { invoke: { src: "worker", id: "worker", address, onDone: { stay: true } } } }
})
const owning = definition.handle({ initial, states: { Busy: { invoke: { src: "quiet" } } } })
const stopping = definition.handle({
  initial,
  states: { Busy: { invoke: { src: "stopStored", onDone: { stay: true } } } }
})
const stoppingStream = definition.handle({
  initial,
  states: { Busy: { invoke: { src: "stopping", onElement: { stay: true }, onDone: { stay: true } } } }
})
const spawning = definition.handle({
  initial,
  states: { Busy: { invoke: { src: "spawning", id: "worker", address, onDone: { stay: true } } } }
})
// Three unsupported entries, in different states and in one list.
const several = definition.handle({
  initial,
  states: {
    Idle: {
      invoke: [
        { src: "load", onDone: { stay: true } },
        { src: "feed", onElement: { stay: true }, onDone: { stay: true } },
        { src: "stop", onDone: { stay: true } }
      ]
    },
    Busy: { invoke: { src: "worker", id: "worker", address, onDone: { stay: true } } }
  }
})
const streamAndLogic = definition.handle({
  initial,
  states: {
    Idle: { invoke: { src: "feed", onElement: { stay: true }, onDone: { stay: true } } },
    Busy: { invoke: { src: "worker", id: "worker", address, onDone: { stay: true } } }
  }
})
const owningStreaming = definition.handle({ initial, states: { Busy: { invoke: { src: "streaming" } } } })
const owningSending = definition.handle({ initial, states: { Busy: { invoke: { src: "sending" } } } })
const owningOwner = definition.handle({
  initial,
  states: { Busy: { invoke: { src: "grandparent", onFailure: { stay: true } } } }
})

// A state that picks its work by a condition requires what every choice requires.
declare const flag: boolean
const choosingTimer = definition.handle({
  initial,
  states: { Busy: { invoke: { src: flag ? "load" : "wait", onDone: { stay: true } } } }
})
const choosingStream = definition.handle({
  initial,
  states: { Busy: { invoke: { src: flag ? "feed" : "stopping", onElement: { stay: true }, onDone: { stay: true } } } }
})
const choosingInList = definition.handle({
  initial,
  states: {
    Busy: {
      invoke: [
        { src: "wait", onDone: { stay: true } },
        { src: flag ? "stopStored" : "load", onDone: { stay: true } }
      ]
    }
  }
})

type Services<M extends Machine.Machine.Any> = Machine.Machine.Services<M>

describe("InvocationSupport", () => {
  it("names the kinds that not every host runs", () => {
    expect<Machine.InvocationSupport.Kind>().type.toBe<"Stream" | "Logic" | "Child">()
    expect<Machine.InvocationSupport<"Stream">>().type.not.toBeAssignableTo<Machine.InvocationSupport<"Logic">>()
    expect<Machine.InvocationSupport<"Stream">>().type.not.toBeAssignableTo<Machine.MachineRuntime>()
    expect<Machine.MachineRuntime>().type.not.toBeAssignableTo<
      Machine.InvocationSupport<Machine.InvocationSupport.Kind>
    >()
  })

  it("is required by what a state invokes, not by what a machine registers", () => {
    expect<Services<typeof handled>>().type.toBe<never>()
    expect<Services<typeof hosted>>().type.toBe<Database>()
    expect<Services<typeof timed>>().type.toBe<never>()
    expect<Services<typeof streaming>>().type.toBe<Feed | Machine.InvocationSupport<"Stream">>()
    expect<Services<typeof working>>().type.toBe<Worker | Machine.InvocationSupport<"Logic">>()
    expect<Services<typeof owning>>().type.toBe<Machine.InvocationSupport<"Child">>()
    expect<Services<typeof several>>().type.toBe<
      | Database
      | Feed
      | Worker
      | Machine.MachineRuntime
      | Machine.InvocationSupport<"Stream">
      | Machine.InvocationSupport<"Logic">
    >()
  })

  it("is required by every source a state can pick by a condition", () => {
    expect<Services<typeof choosingTimer>>().type.toBe<Database>()
    expect<Services<typeof choosingStream>>().type.toBe<
      Feed | Machine.MachineRuntime | Machine.InvocationSupport<"Stream">
    >()
    expect<Services<typeof choosingInList>>().type.toBe<Database | Machine.MachineRuntime>()
  })

  it("reaches a parent from the child machines it invokes", () => {
    expect<Services<typeof owningStreaming>>().type.toBe<
      Machine.InvocationSupport<"Child"> | Machine.InvocationSupport<"Stream">
    >()
    expect<Services<typeof owningSending>>().type.toBe<Machine.InvocationSupport<"Child"> | Machine.MachineRuntime>()
    expect<Services<typeof owningOwner>>().type.toBe<
      Machine.InvocationSupport<"Child"> | Machine.InvocationSupport<"Stream">
    >()
  })

  it("is not required to spawn a child, which a host that spawns runs whatever it invokes", () => {
    type Streaming = Machine.ChildMachine<"streaming", typeof streamingChild>
    expect<Machine.ChildMachine.StartRequirements<Streaming>>().type.toBe<never>()
    const owner = null! as Machine.ChildOwner<never>
    expect<Effect.Services<ReturnType<typeof owner.spawn<Streaming>>>>().type.toBe<never>()
    expect<
      Machine.ChildMachine.StartRequirements<Machine.ChildMachine<"several", typeof several>>
    >().type.toBe<Database | Feed | Worker>()
  })
})

describe("MachineRuntime", () => {
  it("is required only when the invoked Effect, Stream, or Logic requires it", () => {
    expect<Services<typeof stopping>>().type.toBe<Machine.MachineRuntime | Database>()
    expect<Services<typeof stoppingStream>>().type.toBe<
      Machine.MachineRuntime | Machine.InvocationSupport<"Stream">
    >()
    expect<Services<typeof spawning>>().type.toBe<Machine.MachineRuntime | Machine.InvocationSupport<"Logic">>()
  })
})

describe("LocalMachine", () => {
  it("requires the services of a machine only, whatever it invokes", () => {
    expect<LocalMachine.RequiredServices<Services<typeof hosted>>>().type.toBe<Database>()
    expect<LocalMachine.RequiredServices<Services<typeof streaming>>>().type.toBe<Feed>()
    expect<LocalMachine.RequiredServices<Services<typeof working>>>().type.toBe<Worker>()
    expect<LocalMachine.RequiredServices<Services<typeof owning>>>().type.toBe<never>()
    expect<LocalMachine.RequiredServices<Services<typeof several>>>().type.toBe<Database | Feed | Worker>()
    expect<LocalMachine.RequiredServices<any>>().type.toBe<any>()
    expect<LocalMachine.RequiredServices<unknown>>().type.toBe<unknown>()
  })

  const started = {
    handled: LocalMachine.start(handled),
    hosted: LocalMachine.start(hosted),
    timed: LocalMachine.start(timed),
    streaming: LocalMachine.start(streaming),
    working: LocalMachine.start(working),
    owning: LocalMachine.start(owning),
    stopping: LocalMachine.start(stopping),
    stoppingStream: LocalMachine.start(stoppingStream),
    spawning: LocalMachine.start(spawning),
    several: LocalMachine.start(several),
    owningStreaming: LocalMachine.start(owningStreaming),
    owningSending: LocalMachine.start(owningSending),
    owningOwner: LocalMachine.start(owningOwner)
  }
  const prepared = LocalMachine.prepare(several)
  const resumed = LocalMachine.resume(several, null! as Machine.Snapshot<typeof several>)
  type Required<Name extends keyof typeof started> = Effect.Services<(typeof started)[Name]>

  it("starts, prepares, and resumes every machine with the services of its work", () => {
    expect<Required<"handled">>().type.toBe<Scope.Scope>()
    expect<Required<"hosted">>().type.toBe<Scope.Scope | Database>()
    expect<Required<"timed">>().type.toBe<Scope.Scope>()
    expect<Required<"streaming">>().type.toBe<Scope.Scope | Feed>()
    expect<Required<"working">>().type.toBe<Scope.Scope | Worker>()
    expect<Required<"owning">>().type.toBe<Scope.Scope>()
    expect<Required<"stopping">>().type.toBe<Scope.Scope | Database>()
    expect<Required<"stoppingStream">>().type.toBe<Scope.Scope>()
    expect<Required<"spawning">>().type.toBe<Scope.Scope>()
    expect<Required<"several">>().type.toBe<Scope.Scope | Database | Feed | Worker>()
    expect<Required<"owningStreaming">>().type.toBe<Scope.Scope>()
    expect<Required<"owningSending">>().type.toBe<Scope.Scope>()
    expect<Required<"owningOwner">>().type.toBe<Scope.Scope>()
    expect<Effect.Services<Effect.Success<typeof prepared>["start"]>>().type.toBe<
      Scope.Scope | Database | Feed | Worker
    >()
    expect<Effect.Services<typeof resumed>>().type.toBe<Scope.Scope | Database | Feed | Worker>()
  })
})

describe("AtomMachine", () => {
  it("accepts every machine whose services it has", () => {
    expect(AtomMachine.make).type.toBeCallableWith(handled)
    expect(AtomMachine.make).type.toBeCallableWith(timed)
    expect(AtomMachine.make).type.toBeCallableWith(owning)
    expect(AtomMachine.make).type.toBeCallableWith(owningStreaming)
    expect(AtomMachine.make).type.toBeCallableWith(owningSending)
    expect(AtomMachine.make).type.toBeCallableWith(owningOwner)
    expect(AtomMachine.make).type.toBeCallableWith(stoppingStream)
    expect(AtomMachine.make).type.toBeCallableWith(spawning)
    expect(AtomMachine.make).type.toBeCallableWith(streamingChild)
    expect(AtomMachine.make).type.toBeCallableWith(sendingChild)
    expect(AtomMachine.make).type.not.toBeCallableWith(hosted)
    expect(AtomMachine.make).type.not.toBeCallableWith(streaming)
    expect(AtomMachine.make).type.not.toBeCallableWith(working)
    expect(AtomMachine.make).type.not.toBeCallableWith(stopping)
    expect(AtomMachine.make).type.not.toBeCallableWith(several)
  })

  it("requires of its runtime the services of a machine only", () => {
    const bound = AtomMachine.bind(null! as Atom.AtomRuntime<Database | Feed | Worker>)
    expect(bound.make).type.toBeCallableWith(hosted)
    expect(bound.make).type.toBeCallableWith(streaming)
    expect(bound.make).type.toBeCallableWith(working)
    expect(bound.make).type.toBeCallableWith(stopping)
    expect(bound.make).type.toBeCallableWith(several)
    expect(AtomMachine.bind(null! as Atom.AtomRuntime<Database>).make).type.not.toBeCallableWith(several)
    expect(AtomMachine.bind(null! as Atom.AtomRuntime<Database>).make).type.toBeCallableWith(stopping)
  })
})

describe("ClusterMachine", () => {
  type Host = ClusterMachine.Storage | MessageStorage.MessageStorage | Sharding.Sharding
  const options = { version: "1" }

  it("accepts a machine of effects and timers, and requires their services", () => {
    const layer = ClusterMachine.make("Hosted", hosted, options).toLayer()
    expect<Layer.Services<typeof layer>>().type.toBe<Host | Database>()
    const timers = ClusterMachine.make("Timed", timed, options).toLayer()
    expect<Layer.Services<typeof timers>>().type.toBe<Host>()
  })

  it("accepts a machine that registers unsupported sources and invokes none", () => {
    const layer = ClusterMachine.make("Handled", handled, options).toLayer()
    expect<Layer.Services<typeof layer>>().type.toBe<Host>()
  })

  it("names the unsupported kind of a machine it refuses", () => {
    // @ts-expect-error { readonly invocations: "Stream"; readonly capabilities: never; }
    ClusterMachine.make("Streaming", streaming, options)
    // @ts-expect-error { readonly invocations: "Logic"; readonly capabilities: never; }
    ClusterMachine.make("Working", working, options)
    // @ts-expect-error { readonly invocations: never; readonly capabilities: "MachineRuntime"; }
    ClusterMachine.make("Stopping", stopping, options)
  })

  it("names everything unsupported at once", () => {
    // @ts-expect-error { readonly invocations: "Stream" | "Logic"; readonly capabilities: never; }
    ClusterMachine.make("StreamAndLogic", streamAndLogic, options)
    // @ts-expect-error { readonly invocations: "Stream" | "Logic"; readonly capabilities: "MachineRuntime"; }
    ClusterMachine.make("Several", several, options)
    // @ts-expect-error { readonly invocations: "Stream"; readonly capabilities: "MachineRuntime"; }
    ClusterMachine.make("StoppingStream", stoppingStream, options)
    // @ts-expect-error { readonly invocations: "Logic"; readonly capabilities: "MachineRuntime"; }
    ClusterMachine.make("Spawning", spawning, options)
  })

  it("refuses a machine whose state can pick unsupported work by a condition", () => {
    const layer = ClusterMachine.make("ChoosingTimer", choosingTimer, options).toLayer()
    expect<Layer.Services<typeof layer>>().type.toBe<Host | Database>()
    // @ts-expect-error { readonly invocations: "Stream"; readonly capabilities: "MachineRuntime"; }
    ClusterMachine.make("ChoosingStream", choosingStream, options)
    // @ts-expect-error { readonly invocations: never; readonly capabilities: "MachineRuntime"; }
    ClusterMachine.make("ChoosingInList", choosingInList, options)
  })

  it("accepts a machine that invokes a child machine, which runs as an entity of its own", () => {
    const layer = ClusterMachine.make("Owning", owning, options).toLayer()
    expect<Layer.Services<typeof layer>>().type.toBe<Host>()
  })

  it("names what the child machines of a machine use", () => {
    // @ts-expect-error { readonly invocations: "Stream"; readonly capabilities: never; }
    ClusterMachine.make("OwningStreaming", owningStreaming, options)
    // @ts-expect-error { readonly invocations: never; readonly capabilities: "MachineRuntime"; }
    ClusterMachine.make("OwningSending", owningSending, options)
    // @ts-expect-error { readonly invocations: "Stream"; readonly capabilities: never; }
    ClusterMachine.make("OwningOwner", owningOwner, options)
  })

  it("runs work that acts on the child machine of its state, and refuses work on a child address", () => {
    const Quiet = Machine.child("quiet", quiet)
    expect(Machine.sendTo(Quiet, { _tag: "Start" })).type.toBe<
      Effect.Effect<void, Machine.StoppedError, Machine.ChildMachineRuntime>
    >()
    expect(Machine.stopChild(Quiet)).type.toBe<Effect.Effect<void, never, Machine.ChildMachineRuntime>>()
    expect(Machine.stopChild(address)).type.toBe<Effect.Effect<void, never, Machine.MachineRuntime>>()

    const driving = Machine.make({
      root,
      events,
      effects: { drive: Machine.sendTo(Quiet, { _tag: "Start" }), halt: Machine.stopChild(Quiet) },
      children: { quiet: Quiet }
    }).handle({
      initial,
      states: {
        Busy: {
          invoke: [{ src: "quiet" }, { src: "drive", onDone: { stay: true }, onFailure: { stay: true } }, {
            src: "halt",
            onDone: { stay: true }
          }]
        }
      }
    })
    expect<Services<typeof driving>>().type.toBe<Machine.InvocationSupport<"Child"> | Machine.ChildMachineRuntime>()
    expect<LocalMachine.RequiredServices<Services<typeof driving>>>().type.toBe<never>()
    const layer = ClusterMachine.make("Driving", driving, options).toLayer()
    expect<Layer.Services<typeof layer>>().type.toBe<Host>()
  })

  it("hides no requirement of a machine", () => {
    expect<
      ClusterMachine.ClusterMachine<"Stopping", typeof stopping> extends
        ClusterMachine.ClusterMachine<any, any, infer S> ? S : never
    >().type.toBe<Machine.MachineRuntime | Database>()
  })
})

describe("Machine.toStep", () => {
  const self = null! as Machine.MachineTarget<Machine.Machine.EventInputOf<Machine.Machine.InputEvents<typeof handled>>>

  it("accepts a machine of effects, timers, and streams, and requires their services of its work", () => {
    expect(Machine.toStep).type.toBeCallableWith(handled, { self })
    expect(Machine.toStep).type.toBeCallableWith(timed, { self })
    const hostedStep = Machine.toStep(hosted, { self })
    expect<Machine.MachineStep.Requirements<typeof hosted>>().type.toBe<Database>()
    const streamingStep = Machine.toStep(streaming, { self })
    expect<Machine.MachineStep.Requirements<typeof streaming>>().type.toBe<Feed>()
    expect(hostedStep).type.toBe<Machine.MachineStep<Rebuilt<typeof hosted>>>()
    expect(streamingStep).type.toBe<Machine.MachineStep<Rebuilt<typeof streaming>>>()
  })

  it("refuses a machine that invokes a Logic or a child machine, which need a host that owns children", () => {
    // @ts-expect-error { readonly invocations: "Logic"; readonly capabilities: never; }
    Machine.toStep(working, { self })
    // @ts-expect-error { readonly invocations: "Child"; readonly capabilities: never; }
    Machine.toStep(owning, { self })
    // @ts-expect-error { readonly invocations: "Child"; readonly capabilities: never; }
    Machine.toStep(owningStreaming, { self })
  })

  it("refuses a machine whose work acts on children", () => {
    // @ts-expect-error { readonly invocations: never; readonly capabilities: "MachineRuntime"; }
    Machine.toStep(stopping, { self })
    // @ts-expect-error { readonly invocations: never; readonly capabilities: "MachineRuntime"; }
    Machine.toStep(stoppingStream, { self })
    // @ts-expect-error { readonly invocations: "Logic"; readonly capabilities: "MachineRuntime"; }
    Machine.toStep(spawning, { self })
    // @ts-expect-error { readonly invocations: "Logic"; readonly capabilities: "MachineRuntime"; }
    Machine.toStep(several, { self })
    // @ts-expect-error { readonly invocations: never; readonly capabilities: "MachineRuntime"; }
    Machine.toStep(choosingInList, { self })
  })

  it("refuses work that acts on the child machine of a state", () => {
    const Quiet = Machine.child("quiet", quiet)
    const driving = Machine.make({ root, events, effects: { drive: Machine.sendTo(Quiet, { _tag: "Start" }) } })
      .handle({
        initial,
        states: { Busy: { invoke: { src: "drive", onDone: { stay: true }, onFailure: { stay: true } } } }
      })
    expect<Services<typeof driving>>().type.toBe<Machine.ChildMachineRuntime>()
    // @ts-expect-error { readonly invocations: never; readonly capabilities: "ChildMachineRuntime"; }
    Machine.toStep(driving, { self })
  })
})

describe("erased machines", () => {
  const anyRequirements = Machine.make({
    root,
    events,
    effects: { load: null! as Effect.Effect<void, never, any> },
    streams: { feed: null! as Stream.Stream<number, never, any> }
  }).handle({
    initial,
    states: {
      Busy: {
        invoke: [
          { src: "load", onDone: { stay: true } },
          { src: "feed", onElement: { stay: true }, onDone: { stay: true } }
        ]
      }
    }
  })
  const anyConfig: any = null

  it("keep their requirements as any", () => {
    expect<Services<Machine.Machine.Any>>().type.toBe<any>()
    expect<Services<typeof anyRequirements>>().type.toBe<any>()
    expect<Machine.ChildMachine.StartRequirements<Machine.ChildMachine.Any>>().type.toBe<any>()
  })

  it("are accepted where the compiler has nothing to check", () => {
    expect(ClusterMachine.make).type.toBeCallableWith("AnyRequirements", anyRequirements, { version: "1" })
    expect(LocalMachine.start).type.toBeCallableWith(anyRequirements)
  })

  it("gain no requirement from a config that is any", () => {
    const anyState = definition.handle({ initial, states: { Busy: anyConfig } })
    expect<Services<typeof anyState>>().type.toBe<never>()
    expect(ClusterMachine.make).type.toBeCallableWith("AnyState", anyState, { version: "1" })
  })
})
