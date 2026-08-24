# @typeonce/effect-machine-devtools

## 0.24.0

### Minor Changes

- eda432c: Add planner-backed simulation sessions to the web visualizer. Machine and event inputs are rendered as fields from their Effect schemas, including type and constraint metadata, nested objects, arrays, unions, enums, literals, booleans, strings, and numbers. Browser constraints provide immediate feedback, while authoritative Effect Schema failures are mapped back to their fields. Each isolated step uses the real Effect Machine planner and shows selected branches, concrete topology changes, raised and emitted events, planned commands, completion, and output as a structured trace.

  Expose `Machine.inputEventSchemas` so inspection tools can describe or construct valid public events without reaching into the opaque event protocol. Planning evaluates synchronous statechart callbacks but does not commit commands or start runtime activities. Schema and planning failures remain visible beside the machine topology.

### Patch Changes

- Updated dependencies [eda432c]
  - @typeonce/effect-machine@0.24.0

## 0.23.0

### Minor Changes

- f90b37d: Add a local interactive text visualizer prototype that renders the public machine inspection data as a collapsible tree.

  Use the text tree to navigate topology, expand nested states, select subtrees, and inspect structured machine details without converting the model into a chart.

- f90b37d: Add `MachineSimulator` and browser controls for side-effect-free, best-effort topology simulation. Direct required transitions advance the active tree; runtime-dependent transitions remain visibly indeterminate instead of executing user code or guessing.
- f90b37d: Add a local `effect-machine` command that discovers exported `.handle(...)` machines, keeps their last valid inspection document across incomplete reloads, and serves the live interactive text visualizer.

  Native file-system events are used by default. Pass `--watch-polling` on platforms where native events are unavailable.

### Patch Changes

- f90b37d: Release `@typeonce/effect-machine` and `@typeonce/effect-machine-devtools` at the same version. Install matching versions so the devtools inspection protocol and machine model remain compatible.
- Updated dependencies [f90b37d]
- Updated dependencies [f90b37d]
  - @typeonce/effect-machine@0.23.0
