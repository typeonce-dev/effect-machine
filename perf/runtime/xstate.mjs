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

  return {
    implementation,
    label,
    version,
    async: false,
    planCounterBatch,
    runCounterBurst,
    runLifecycle,
    startCounter,
    startCounters,
    stopCounter,
    stopCounters
  }
}
