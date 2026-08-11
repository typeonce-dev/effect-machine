import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { Match } from "effect"
import { useState } from "react"
import { ExamplePage } from "../../components/ExamplePage.tsx"
import { turnstileAtom } from "./atoms.ts"
import { TurnstileEvent } from "./machine.ts"

export function TurnstilePage() {
  const stateResult = useAtomValue(turnstileAtom.state)
  const send = useAtomSet(turnstileAtom.send)
  const [lastCommand, setLastCommand] = useState("Insert a coin to unlock the gate.")

  return (
    <ExamplePage
      title="Turnstile"
      summary="A minimal machine where each state accepts one command and safely ignores the other."
      machineFile="src/examples/turnstile/machine.ts"
    >
      {Match.value(stateResult).pipe(
        Match.tagsExhaustive({
          Initial: () => <div className="example-message">Starting the turnstile…</div>,
          Failure: () => <div className="example-message is-error">The turnstile failed to start.</div>,
          Success: ({ value: state }) => {
            const locked = state.path === "Locked"
            return (
              <div className="machine-demo turnstile-demo">
                <div className={`turnstile${locked ? " is-locked" : " is-unlocked"}`} aria-hidden="true">
                  <div className="turnstile-arm" />
                  <div className="turnstile-post" />
                </div>
                <div className="machine-demo-copy">
                  <p className="machine-state-label">Current state</p>
                  <h2>{locked ? "Locked" : "Unlocked"}</h2>
                  <p aria-live="polite">{lastCommand}</p>
                  <div className="machine-controls">
                    <button
                      type="button"
                      onClick={() => {
                        setLastCommand(
                          locked ? "Coin accepted. Gate unlocked." : "Coin ignored: the gate is already unlocked."
                        )
                        send(TurnstileEvent.cases.CoinInserted.make({}))
                      }}
                    >
                      Insert coin
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setLastCommand(
                          locked ? "Push ignored: insert a coin first." : "Gate pushed. Turnstile locked again."
                        )
                        send(TurnstileEvent.cases.GatePushed.make({}))
                      }}
                    >
                      Push gate
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
