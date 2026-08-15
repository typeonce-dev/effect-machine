import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { Match } from "effect"
import { ExamplePage } from "../../components/ExamplePage.tsx"
import { trafficLightAtom } from "./atoms.ts"
import { trafficLightDurations, TrafficLightEvents } from "./machine.ts"

export function TrafficLightPage() {
  const stateResult = useAtomValue(trafficLightAtom.state)
  const send = useAtomSet(trafficLightAtom.send)

  return (
    <ExamplePage
      title="Traffic light"
      summary="Each signal owns a cancellable delay; leaving the state replaces its timer with the next signal's timer."
      machineFile="src/examples/traffic-light/machine.ts"
    >
      {Match.value(stateResult).pipe(
        Match.tagsExhaustive({
          Initial: () => <div className="example-message">Starting the signal cycle…</div>,
          Failure: () => <div className="example-message is-error">The traffic light failed to start.</div>,
          Success: ({ value: state }) => {
            const signal = state.path
            const red = signal === "Red" || signal === "RedYellow"
            const yellow = signal === "RedYellow" || signal === "Yellow"
            const green = signal === "Green"
            const duration = trafficLightDurations[signal]

            return (
              <div className="machine-demo traffic-light-demo">
                <div className="traffic-light" aria-label={`${signal} traffic signal`}>
                  <span className={`red${red ? " is-active" : ""}`} />
                  <span className={`yellow${yellow ? " is-active" : ""}`} />
                  <span className={`green${green ? " is-active" : ""}`} />
                </div>
                <div className="machine-demo-copy">
                  <p className="machine-state-label">Current state</p>
                  <h2>{signal === "RedYellow" ? "Red + yellow" : signal}</h2>
                  <p>
                    The next transition is scheduled in {(duration / 1_000).toFixed(1)} seconds by a state-scoped{` `}
                    an inline <code>after</code> invocation.
                  </p>
                  <div className="timer-track" key={state.path}>
                    <span style={{ animationDuration: `${duration}ms` }} />
                  </div>
                  <div className="machine-controls">
                    <button type="button" onClick={() => send(TrafficLightEvents.Reset())}>
                      Reset cycle
                    </button>
                  </div>
                </div>
              </div>
            )
          }
        })
      )}
    </ExamplePage>
  )
}
