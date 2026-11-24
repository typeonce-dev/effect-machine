/** Every way in which a host does not do what a scenario says. */
import type { Difference } from "./support/difference.js"
import { failed, final, running, started } from "./support/scenario.js"

const cluster = ["ClusterMachine"]
const clusterDocs = "src/unstable/cluster/ClusterMachine.ts"

const plansTheInitialStateLate = {
  kind: "Deliberate",
  hosts: cluster,
  because: "An entity has no state of its own before a request creates it, so nothing is stored for one nobody used.",
  documentedIn: {
    file: clusterDocs,
    text: "A missing checkpoint runs initial planning before the first event."
  }
} as const

const acceptsAfterTheEnd = {
  kind: "Deliberate",
  hosts: cluster,
  because: "A request can be delivered again after the machine ended, and must then get the answer it had before.",
  documentedIn: { file: clusterDocs, text: "Final checkpoints accept later requests as no-ops." }
} as const

const rejectsTheEvent = {
  kind: "Deliberate",
  hosts: cluster,
  because: "The sender waits for a reply, so the step is rolled back and the sender is told.",
  documentedIn: {
    file: clusterDocs,
    text: "Rejected Cluster machine request. Transaction-participating durable storage leaves the previous " +
      "checkpoint in place and suppresses emitted events."
  }
} as const

/** A step that cannot be applied, in a scenario made by `breaks`. */
const rejected = (scenario: string): Difference => ({
  ...rejectsTheEvent,
  scenario,
  differs: "Rejects the event and keeps the machine, instead of failing it.",
  steps: {
    "the event that cannot be applied": { answers: ["Rejected"], outcome: running },
    "an event after it": { answers: ["Accepted"], happens: [{ Idle: { notes: 2 } }] }
  }
})

const resumesAWait = {
  kind: "Deliberate",
  hosts: cluster,
  because: "The due time is stored with the state, so a restart neither delays nor repeats the wait.",
  documentedIn: {
    file: clusterDocs,
    text: "waits only for the time that remains, and completes a timer whose time has passed at once."
  }
} as const

export const differences: ReadonlyArray<Difference> = [
  {
    ...plansTheInitialStateLate,
    scenario: "settles in its initial state before any event",
    differs: "Plans the initial state together with the first event.",
    steps: { start: { log: [] }, "send Note": { log: ["enter Passing", "enter Idle"] } }
  },
  {
    ...plansTheInitialStateLate,
    scenario: "cannot settle in its initial state",
    differs: "Plans the initial state with each event, and rejects the event instead of failing the machine.",
    steps: { start: { outcome: running }, "send Note": { answers: ["Rejected"] } }
  },
  {
    ...plansTheInitialStateLate,
    scenario: "ends at once when its initial state is final",
    differs: "Ends with the first event, which it accepts.",
    steps: {
      start: { outcome: running },
      "send Note": { answers: ["Accepted"], outcome: final("nothing to do") }
    }
  },
  {
    ...plansTheInitialStateLate,
    scenario: "starts the work of its initial state before any event",
    differs: "Starts the work of the initial state after the first event.",
    steps: {
      start: { happens: [], log: [] },
      "send Note": {
        happens: [started("outer"), started("inner")],
        log: ["outer by initial", "inner by initial"]
      }
    }
  },
  {
    ...plansTheInitialStateLate,
    scenario: "stops all work when it ends, also that of states that stay active",
    differs: "Starts the work of the initial state after the first event.",
    steps: { start: { happens: [] }, "send Note": { happens: [started("whole"), started("open")] } }
  },
  {
    ...plansTheInitialStateLate,
    scenario: "counts the timer of its initial state from its start",
    differs: "Counts the timer of the initial state from the first event.",
    steps: {
      "10 seconds after the start": { happens: [] },
      "10 seconds after the first event": { happens: [{ Expired: {} }] }
    }
  },
  {
    ...acceptsAfterTheEnd,
    scenario: "ends in a final state with its output, and takes no event after it",
    differs: "Accepts an event after the end, and does nothing with it.",
    steps: { "event after the end": { answers: ["Accepted"] } }
  },
  {
    ...acceptsAfterTheEnd,
    scenario: "restarts after it ended",
    differs: "Accepts an event after the end, and does nothing with it.",
    steps: { "an event after it": { answers: ["Accepted"] } }
  },
  rejected("a transition throws"),
  rejected("a step never settles"),
  rejected("a transition leads to a state that its schema refuses"),
  rejected("a transition emits an event that its schema refuses"),
  {
    kind: "Deliberate",
    hosts: cluster,
    scenario: "takes the events that its own work sends to it",
    differs: "Fails the machine when its work sends to it.",
    because: "An event sent through a local target is not durable.",
    documentedIn: {
      file: clusterDocs,
      text: "Work that uses `self.send`, `self.sessionId`, or an operation of `children` from the context of its " +
        "input mapper. It fails the machine."
    },
    steps: {
      "work succeeds": { happens: [], outcome: failed("self.send is process-local and is not supported") },
      "an event after it": { answers: ["Ended"], happens: [] }
    }
  },
  {
    kind: "Deliberate",
    hosts: cluster,
    scenario: "evaluates a duration in order with the other invocations of its state",
    differs: "Evaluates durations before any work of the state starts.",
    because: "The due time is stored in the step that enters the state, and work starts once that is stored.",
    documentedIn: {
      file: clusterDocs,
      text: "The duration of a timer is evaluated after the step that enters its state is planned and before that " +
        "step is stored, and not again while its due time is stored. The local runtime evaluates it once the state " +
        "is entered, in order with the other invocations of the state."
    },
    steps: { "send Go": { log: ["wait by Go", "first by Go", "last by Go"] } }
  },
  {
    ...resumesAWait,
    scenario: "restarts while a timer waits",
    differs: "Waits for the time that remains, and evaluates nothing again.",
    steps: {
      restart: { log: [] },
      "the time that remained": { happens: [{ Expired: {} }] },
      "60 seconds after the restart": { happens: [] }
    }
  },
  {
    ...resumesAWait,
    scenario: "restarts after a timer fell due",
    differs: "Fires the timer at once, and evaluates nothing again.",
    steps: {
      restart: { happens: [{ Expired: {} }], log: [] },
      "60 seconds after the restart": { happens: [] }
    }
  },
  {
    kind: "Deliberate",
    hosts: cluster,
    scenario: "restarts in a state whose work has ended",
    differs: "Does not run work again that ended while its state stayed active.",
    because: "The end of the work was applied and stored, so running it again would apply it twice.",
    documentedIn: {
      file: clusterDocs,
      text: "An invocation that ended while its state stayed active is not started again until its state is entered " +
        "again."
    },
    steps: {
      restart: { happens: [started("second")] },
      "enter again": { stopped: ["second"] }
    }
  },
  {
    kind: "Deliberate",
    hosts: cluster,
    scenario: "restarts after it failed",
    differs: "Stays failed.",
    because: "The failure is stored with the last state, and there is no hidden retry of failed work.",
    documentedIn: {
      file: clusterDocs,
      text: "The machine failed. It is terminal, runs no work, and rejects every later request as `MachineFailed`."
    },
    steps: {
      restart: { happens: [], outcome: failed("Error: broken") },
      "load succeeds": { happens: [] }
    }
  },
  {
    kind: "Open",
    hosts: cluster,
    scenario: "refuses the payload of an event that its schema refuses",
    differs: "The client refuses the payload, and the machine goes on.",
    evidence:
      "The entity client validates the payload before it sends it, and dies with \"Schema validation failed\" " +
      "in the fiber of the caller. The adapter of this suite reads that as a rejection. The documentation says that " +
      "events are schema-validated, and neither that the machine survives nor that the caller gets a defect.",
    steps: {
      "an invalid payload": { answers: ["Rejected"], outcome: running },
      "an event after it": { answers: ["Accepted"], happens: [{ Count: { length: 5 } }] }
    }
  },
  {
    kind: "Open",
    hosts: cluster,
    scenario: "takes an event that a constructor of its protocol built",
    differs: "Refuses an event with fields that a constructor of the protocol built.",
    evidence:
      "`Machine.events` returns constructors whose result holds its fields behind a symbol. The entity client " +
      "expects the fields themselves, so its types refuse such an event, and at run time it dies with \"Schema " +
      "validation failed\". An event without fields passes. The documentation does not say what the client takes.",
    steps: {
      "send Open": { answers: ["Rejected"], happens: [] },
      "send Close": { happens: [] }
    }
  }
]
