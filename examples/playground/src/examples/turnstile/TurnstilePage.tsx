import { ExamplePage, StarterPanel } from "../../components/ExamplePage.tsx"
import { TurnstileMachine } from "./machine.ts"

export function TurnstilePage() {
  void TurnstileMachine

  return (
    <ExamplePage
      title="Turnstile"
      summary="Start with the smallest useful machine, then decide how the UI should expose ignored and accepted events."
      machineFile="src/examples/turnstile/machine.ts"
    >
      <StarterPanel>
        <div className="placeholder-object" aria-hidden="true">
          <div className="turnstile-arm" />
          <div className="turnstile-post" />
        </div>
        <h2>Connect the machine</h2>
        <p>
          The starter already models <code>Locked</code>, <code>Unlocked</code>, <code>CoinInserted</code>, and{` `}
          <code>GatePushed</code>. Mount it with <code>AtomMachine</code> and add the controls here.
        </p>
      </StarterPanel>
    </ExamplePage>
  )
}
