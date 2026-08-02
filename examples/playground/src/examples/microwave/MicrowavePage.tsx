import { ExamplePage, StarterPanel } from "../../components/ExamplePage.tsx"
import { MicrowaveMachine } from "./machine.ts"

export function MicrowavePage() {
  void MicrowaveMachine

  return (
    <ExamplePage
      title="Microwave"
      summary="Explore parallel door and engine regions while keeping unsafe combinations out of the transition logic."
      machineFile="src/examples/microwave/machine.ts"
    >
      <StarterPanel>
        <div className="microwave" aria-hidden="true">
          <div className="microwave-window" />
          <div className="microwave-controls">
            <span />
            <span />
            <span />
          </div>
        </div>
        <h2>Define the safety rules</h2>
        <p>
          The parallel statechart is scaffolded. Add transitions for power, door changes, elapsed time, and automatic
          interruption.
        </p>
      </StarterPanel>
    </ExamplePage>
  )
}
