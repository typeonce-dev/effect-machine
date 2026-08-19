import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { Match } from "effect"
import { ExamplePage } from "../../components/ExamplePage.tsx"
import { microwaveAtom } from "./atoms.ts"
import { MicrowaveEvents } from "./machine.ts"

export function MicrowavePage() {
  const stateResult = useAtomValue(microwaveAtom.state)
  const send = useAtomSet(microwaveAtom.send)

  return (
    <ExamplePage
      title="Microwave"
      summary="The door hierarchy makes cooking with an open door structurally impossible, and leaving Cooking interrupts its timer."
      machineFile="src/examples/microwave/machine.ts"
    >
      {Match.value(stateResult).pipe(
        Match.tagsExhaustive({
          Initial: () => <div className="example-message">Starting the microwave…</div>,
          Failure: () => <div className="example-message is-error">The microwave failed to start.</div>,
          Success: ({ value: state }) => {
            const oven = state.state
            const open = oven.path === "Oven.Open"
            const cooking = oven.path === "Oven.Closed" && oven.state.path === "Oven.Closed.Cooking"
            const elapsedSeconds = cooking ? oven.state.value.elapsedSeconds : 0
            const engineName = cooking ? "Cooking" : "Idle"
            const doorName = open ? "Open" : "Closed"

            return (
              <div className="machine-demo microwave-demo">
                <div className={`microwave${cooking ? " is-cooking" : ""}${open ? " is-open" : ""}`}>
                  <div className="microwave-window" aria-hidden="true">
                    <span />
                  </div>
                  <div className="microwave-controls" aria-hidden="true">
                    <strong>{String(elapsedSeconds).padStart(2, "0")}</strong>
                    <span />
                    <span />
                  </div>
                </div>
                <div className="machine-demo-copy">
                  <p className="machine-state-label">Hierarchical safety state</p>
                  <h2>{cooking ? `Cooking · ${elapsedSeconds}s` : open ? "Idle · door open" : "Idle · door closed"}</h2>
                  <p>
                    Engine: <code>{engineName}</code> · Door: <code>{doorName}</code>
                  </p>
                  <div className="machine-controls">
                    <button
                      type="button"
                      disabled={open}
                      onClick={() => send(MicrowaveEvents.PowerPressed())}
                    >
                      {cooking ? "Stop" : "Start"}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        send(
                          open ? MicrowaveEvents.DoorClosed() : MicrowaveEvents.DoorOpened()
                        )}
                    >
                      {open ? "Close door" : "Open door"}
                    </button>
                  </div>
                  <p className="safety-note" aria-live="polite">
                    {open
                      ? "Power is disabled while the door is open."
                      : "Opening the door while cooking stops the engine."}
                  </p>
                </div>
              </div>
            )
          }
        })
      )}
    </ExamplePage>
  )
}
