import { ExamplePage, StarterPanel } from "../../components/ExamplePage.tsx"
import { TrafficLightMachine } from "./machine.ts"

export function TrafficLightPage() {
  void TrafficLightMachine

  return (
    <ExamplePage
      title="Traffic light"
      summary="Turn the explicit TimerElapsed cycle into state-scoped delays and make each signal duration visible."
      machineFile="src/examples/traffic-light/machine.ts"
    >
      <StarterPanel>
        <div className="traffic-light" aria-label="Inactive traffic light placeholder">
          <span className="red" />
          <span className="yellow" />
          <span className="green" />
        </div>
        <h2>Add state-scoped timers</h2>
        <p>
          The transition cycle is ready. Replace manual events with{" "}
          <code>Machine.after</code>, then render the current state here.
        </p>
      </StarterPanel>
    </ExamplePage>
  )
}
