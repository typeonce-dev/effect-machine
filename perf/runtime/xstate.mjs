const incrementEvent = Object.freeze({ type: "Increment" })
const finishEvent = Object.freeze({ type: "Finish" })

export const makeXStateAdapter = (options) => {
  const { implementation, label, version, xstate } = options
  const increment = typeof xstate.assign === "function"
    ? {
      actions: xstate.assign({
        value: ({ context }) => context.value + 1
      })
    }
    : ({ context }) => ({
      context: { value: context.value + 1 }
    })

  const machine = xstate.createMachine({
    id: `RuntimeBenchmarkCounter-${implementation}`,
    context: { value: 0 },
    initial: "counting",
    states: {
      counting: {
        on: {
          Increment: increment,
          Finish: { target: "done" }
        }
      },
      done: { type: "final" }
    }
  })
  const parentMachine = xstate.createMachine({
    id: `RuntimeBenchmarkCounterParent-${implementation}`,
    initial: "active",
    states: {
      active: {
        invoke: {
          id: "counter",
          src: machine
        }
      }
    }
  })
  const initialSnapshot = xstate.initialTransition(machine)[0]

  const planCounterBatch = (size) => {
    let snapshot = initialSnapshot
    for (let index = 0; index < size; index += 1) {
      snapshot = xstate.transition(machine, snapshot, incrementEvent)[0]
    }
    return snapshot.context.value
  }

  const startCounter = () => xstate.createActor(machine).start()
  const stopCounter = (actor) => actor.stop()

  const startObservedCounter = () => {
    const actor = xstate.createActor(machine)
    let observed
    let complete
    const completion = new Promise((resolve) => {
      complete = resolve
    })
    const subscription = actor.subscribe({
      next: (snapshot) => {
        observed = snapshot
      },
      complete
    })
    actor.start()
    return { actor, completion, getObserved: () => observed, subscription }
  }
  const stopObservedCounter = ({ actor, subscription }) => {
    actor.stop()
    subscription.unsubscribe()
  }

  const startChildCounter = () => {
    const parent = xstate.createActor(parentMachine).start()
    if (parent.getSnapshot().children.counter === undefined) {
      parent.stop()
      throw new Error(`${label} child did not become ready`)
    }
    return parent
  }
  const stopChildCounter = (parent) => parent.stop()

  const runCounterBurst = (actor, size) => {
    for (let index = 0; index < size; index += 1) {
      actor.send(incrementEvent)
    }
    actor.send(finishEvent)
    const snapshot = actor.getSnapshot()
    if (snapshot.status !== "done") {
      throw new Error(`${label} terminal fence produced status ${snapshot.status}`)
    }
    return snapshot.context.value
  }

  const runObservedCounterBurst = async ({ actor, completion, getObserved }, size) => {
    for (let index = 0; index < size; index += 1) {
      actor.send(incrementEvent)
    }
    actor.send(finishEvent)
    await completion
    const snapshot = getObserved()
    if (snapshot?.status !== "done") {
      throw new Error(`${label} observed terminal fence produced status ${snapshot?.status}`)
    }
    return snapshot.context.value
  }

  const runChildCounterBurst = (parent, size) => {
    for (let index = 0; index < size; index += 1) {
      const child = parent.getSnapshot().children.counter
      if (child === undefined) {
        throw new Error(`${label} child disappeared during the benchmark`)
      }
      child.send(incrementEvent)
    }
    const child = parent.getSnapshot().children.counter
    if (child === undefined) {
      throw new Error(`${label} child disappeared before the terminal fence`)
    }
    child.send(finishEvent)
    const snapshot = child.getSnapshot()
    if (snapshot.status !== "done") {
      throw new Error(`${label} child terminal fence produced status ${snapshot.status}`)
    }
    return snapshot.context.value
  }

  const runLifecycle = () => {
    const actor = startCounter()
    try {
      const snapshot = actor.getSnapshot()
      if (snapshot.status !== "active" || snapshot.context.value !== 0) {
        throw new Error(`${label} lifecycle benchmark produced an invalid initial snapshot`)
      }
    } finally {
      stopCounter(actor)
    }
  }

  const runChildLifecycle = () => {
    const parent = startChildCounter()
    try {
      const child = parent.getSnapshot().children.counter
      if (child === undefined || child.getSnapshot().status !== "active") {
        throw new Error(`${label} child lifecycle benchmark produced an invalid initial snapshot`)
      }
    } finally {
      stopChildCounter(parent)
    }
  }

  const startCounters = (count) => {
    const actors = []
    for (let index = 0; index < count; index += 1) {
      actors.push(startCounter())
    }
    return actors
  }

  const stopCounters = (actors) => {
    for (const actor of actors) {
      stopCounter(actor)
    }
  }

  const startChildCounters = (count) => {
    const actors = []
    for (let index = 0; index < count; index += 1) {
      actors.push(startChildCounter())
    }
    return actors
  }

  const stopChildCounters = stopCounters

  const startIndependentCounterPairs = (count) => {
    const pairs = []
    for (let index = 0; index < count; index += 1) {
      pairs.push([startCounter(), startCounter()])
    }
    return pairs
  }

  const stopIndependentCounterPairs = (pairs) => stopCounters(pairs.flat())

  return {
    implementation,
    label,
    version,
    async: false,
    planCounterBatch,
    runCounterBurst,
    runChildCounterBurst,
    runChildLifecycle,
    runLifecycle,
    runObservedCounterBurst,
    startCounter,
    startChildCounter,
    startCounters,
    startChildCounters,
    startObservedCounter,
    stopCounter,
    stopChildCounter,
    stopChildCounters,
    stopCounters,
    stopObservedCounter,
    memoryProfiles: {
      idle: {
        label: "Idle machine",
        start: startCounters,
        stop: stopCounters
      },
      "two-independent": {
        label: "Two independent idle machines",
        start: startIndependentCounterPairs,
        stop: stopIndependentCounterPairs
      },
      "parent-with-child": {
        label: "Idle parent with one child",
        start: startChildCounters,
        stop: stopChildCounters
      }
    }
  }
}
