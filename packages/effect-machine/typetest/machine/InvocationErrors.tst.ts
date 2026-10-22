import { Effect, Schema, Stream } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"
import { AtomMachine } from "../../src/unstable/reactivity/index.js"

class Watching extends Schema.TaggedClass<Watching>("InvocationErrorsWatching")("Watching", {}) {}
class Loading extends Schema.TaggedClass<Loading>("InvocationErrorsLoading")("Loading", {}) {}
class Ready extends Schema.TaggedClass<Ready>("InvocationErrorsReady")("Ready", {}) {}
class Owning extends Schema.TaggedClass<Owning>("InvocationErrorsOwning")("Owning", {}) {}
class Waiting extends Schema.TaggedClass<Waiting>("InvocationErrorsWaiting")("Waiting", {}) {}
class Next extends Schema.TaggedClass<Next>("InvocationErrorsNext")("Next", {}) {}
class Notice extends Schema.TaggedClass<Notice>("InvocationErrorsNotice")("Notice", {}) {}

type FrameworkError = Machine.InfiniteTransitionError | Machine.MachineSchemaDecodeError | Machine.StoppedError

const watcher = Machine.make({
  streams: { ticks: Stream.make(1, 2, 3) },
  root: Machine.state({ states: { Watching } }),
  events: Machine.eventsFromSchemas()
}).handle({
  initial: { target: "Watching" },
  states: {
    Watching: { invoke: { src: "ticks", onElement: { none: true }, onDone: { none: true } } }
  }
})

const loader = Machine.make({
  effects: { load: Effect.succeed(1) },
  timers: { delay: "1 second" },
  root: Machine.state({ states: { Loading, Ready } }),
  events: Machine.eventsFromSchemas()
}).handle({
  initial: { target: "Loading" },
  states: {
    Loading: { invoke: [{ src: "load", onDone: { target: "Ready" } }, { src: "delay", onDone: { none: true } }] },
    Ready: {}
  }
})

const ChildStates = Machine.state({ states: { Owning } })
const ParentStates = Machine.state({ states: { Owning, Next } })

const owner = Machine.make({
  children: { loader: Machine.child("loader", loader) },
  root: ChildStates,
  events: Machine.eventsFromSchemas()
}).handle({
  initial: { target: "Owning" },
  states: { Owning: { invoke: { src: "loader" } } }
})

describe("invocation error channels", () => {
  it("omits ChildAlreadyExistsError for runtime-owned invocation ids", () => {
    expect<Machine.Machine.Error<typeof watcher>>().type.toBe<never>()
    expect<Machine.Machine.Error<typeof loader>>().type.toBe<never>()
    Effect.gen(function*() {
      const ref = yield* Machine.start(watcher)
      expect<Effect.Error<typeof ref.join>>().type.toBe<FrameworkError>()
    })
  })

  it("keeps ChildAlreadyExistsError for caller-chosen child ids", () => {
    expect<Machine.ChildAlreadyExistsError>().type.toBeAssignableTo<Machine.Machine.Error<typeof owner>>()
    const addressed = Machine.make({
      logic: { blocked: Machine.logic({ initial: undefined, run: () => Effect.never }) },
      root: ChildStates,
      events: Machine.eventsFromSchemas()
    }).handle({
      initial: { target: "Owning" },
      states: { Owning: { invoke: { src: "blocked", id: "worker", address: Machine.childAddress("worker") } } }
    })
    expect<Machine.ChildAlreadyExistsError>().type.toBeAssignableTo<Machine.Machine.Error<typeof addressed>>()
  })

  it("requires onFailure for a fixed child exactly when the child can fail", () => {
    const parent = Machine.make({
      children: { loader: Machine.child("loader", loader), owner: Machine.child("owner", owner) },
      root: ParentStates,
      events: Machine.eventsFromSchemas()
    })
    expect(parent.handle({
      initial: { target: "Owning" },
      states: { Owning: { invoke: { src: "loader" } }, Next: {} }
    })).type.not.toRaiseError()
    expect(parent.handle({
      initial: { target: "Owning" },
      states: { Owning: { invoke: { src: "loader", onFailure: { target: "Next" } } }, Next: {} }
    })).type.toRaiseError("Invocation 'loader' cannot fail, so onFailure is unreachable")
    // The owner's own child invocation can collide, so its failure channel is reachable.
    expect(parent.handle({
      initial: { target: "Owning" },
      states: { Owning: { invoke: { src: "owner" } }, Next: {} }
    })).type.toRaiseError("Property 'onFailure' is missing")
    expect(parent.handle({
      initial: { target: "Owning" },
      states: { Owning: { invoke: { src: "owner", onFailure: { target: "Next" } } }, Next: {} }
    })).type.not.toRaiseError()
  })
})

describe("invocation diagnostics", () => {
  const machine = Machine.make({
    effects: { forever: Effect.never, load: Effect.succeed(1) },
    streams: { ticks: Stream.make(1) },
    root: Machine.state({ states: { Waiting, Next } }),
    events: Machine.eventsFromSchemas()
  })

  it("names unreachable outcome channels", () => {
    expect(machine.handle({
      initial: { target: "Waiting" },
      states: { Waiting: { invoke: { src: "forever", onDone: { target: "Next" } } }, Next: {} }
    })).type.toRaiseError("Invocation 'forever' never completes, so onDone is unreachable")
    expect(machine.handle({
      initial: { target: "Waiting" },
      states: { Waiting: { invoke: { src: "load", onDone: { target: "Next" }, onFailure: { none: true } } }, Next: {} }
    })).type.toRaiseError("Invocation 'load' cannot fail, so onFailure is unreachable")
    expect(machine.handle({
      initial: { target: "Waiting" },
      states: { Waiting: { invoke: { src: "load", onDone: { target: "Next" }, onElement: { none: true } } }, Next: {} }
    })).type.toRaiseError("Invocation 'load' emits no Stream elements, so onElement is unreachable")
    expect(machine.handle({
      initial: { target: "Waiting" },
      states: {
        Waiting: {
          invoke: { src: "ticks", onElement: { none: true }, onDone: { none: true }, onSnapshot: { none: true } }
        },
        Next: {}
      }
    })).type.toRaiseError("Invocation 'ticks' has no snapshots; onSnapshot applies only to logic and child invocations")
  })

  it("keeps reachable outcome channels accepted", () => {
    expect(machine.handle({
      initial: { target: "Waiting" },
      states: { Waiting: { invoke: [{ src: "forever" }, { src: "load", onDone: { target: "Next" } }] }, Next: {} }
    })).type.not.toRaiseError()
  })

  it("names duplicate lifecycle ids in one state", () => {
    expect(machine.handle({
      initial: { target: "Waiting" },
      states: { Waiting: { invoke: [{ src: "forever" }, { src: "forever" }] }, Next: {} }
    })).type.toRaiseError(
      "Invocation id 'forever' is declared more than once in this state",
      "Invocation id 'forever' is declared more than once in this state"
    )
    expect(machine.handle({
      initial: { target: "Waiting" },
      states: {
        Waiting: { invoke: [{ src: "forever", id: "work" }, { src: "load", id: "work", onDone: { target: "Next" } }] },
        Next: {}
      }
    })).type.toRaiseError(
      "Invocation id 'work' is declared more than once in this state",
      "Invocation id 'work' is declared more than once in this state"
    )
    expect(machine.handle({
      initial: { target: "Waiting" },
      states: {
        Waiting: { invoke: [{ src: "forever", id: "first" }, { src: "forever", id: "second" }] },
        Next: {}
      }
    })).type.not.toRaiseError()
  })
})

describe("root compatibility diagnostics", () => {
  const Notices = Machine.eventsFromSchemas(Notice)
  const requiredParent = Machine.make({
    root: Machine.state({ states: { Waiting } }),
    events: Machine.eventsFromSchemas(),
    parent: Machine.parent(Notices)
  }).handle({
    initial: { target: "Waiting" },
    states: { Waiting: {} }
  })
  const optionalParent = Machine.make({
    root: Machine.state({ states: { Waiting } }),
    events: Machine.eventsFromSchemas(),
    parent: Machine.optionalParent(Notices)
  }).handle({
    initial: { target: "Waiting" },
    states: { Waiting: {} }
  })

  it("explains why a machine with a required parent cannot run as a root", () => {
    expect(Machine.planInitial(requiredParent)).type.toRaiseError(
      "Machine declares a required parent and cannot run as a root"
    )
    expect(Machine.start(requiredParent)).type.toRaiseError(
      "Machine declares a required parent and cannot run as a root"
    )
    expect(Machine.prepare(requiredParent)).type.toRaiseError(
      "Machine declares a required parent and cannot run as a root"
    )
    expect(AtomMachine.make(requiredParent)).type.toRaiseError(
      "Machine declares a required parent and cannot run as a root"
    )
    expect(Machine.planInitial(optionalParent)).type.not.toRaiseError()
  })
})
