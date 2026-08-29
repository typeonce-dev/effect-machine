# @typeonce/effect-machine-devtools

## 0.31.0

### Patch Changes

- Updated dependencies [9ec7ef4]
  - @typeonce/effect-machine@0.31.0

## 0.30.0

### Patch Changes

- Updated dependencies [d1f921c]
  - @typeonce/effect-machine@0.30.0

## 0.29.0

### Patch Changes

- Updated dependencies [d739ebd]
  - @typeonce/effect-machine@0.29.0

## 0.28.0

### Patch Changes

- e4b0785: Make statecharts denser by flowing states from top to bottom, replacing full initial-entry lanes with compact top-entry markers, and sizing state cards from their visible names and invocations.

  State values now appear as compact JSON-shaped type previews in the state inspector instead of occupying the topology. Transition labels sit directly on clear route segments when space permits, hierarchy-crossing routes avoid compound-state headers, and routes attach to their actual source and target before turning. Horizontally scrolling machine tabs also keep their position when selecting or live-reloading a machine.

  Charts remain available when every deterministic layout has only cosmetic label-to-route crossings. Structural failures such as detached edges, node crossings, and overlapping routes still prevent rendering.

- Updated dependencies [9aab73e]
  - @typeonce/effect-machine@0.28.0

## 0.27.1

### Patch Changes

- d0d17ee: Lay out every transition through one obstacle-aware chart pipeline, including self-transitions, targetless updates, and transitions between compound states and their children.

  Validate node, label, containment, self-loop clearance, and route-clearance invariants before rendering. The visualizer retries deterministic, progressively more spacious layouts and reports a diagnostic error instead of displaying geometry that violates those constraints.

  - @typeonce/effect-machine@0.27.1

## 0.27.0

### Minor Changes

- eba4c2b: Add `effect-machine build` for publishing the project visualizer as a static website.

  The command inspects the selected machines once, validates their documents, and writes relative HTML, CSS, JavaScript, `machines.json`, and build metadata to `--out-dir`. The generated site keeps the interactive statechart and topology walkthrough without a live devtools server or project code at viewing time.

### Patch Changes

- @typeonce/effect-machine@0.27.0

## 0.26.2

### Patch Changes

- fe42ce0: Keep the statechart available for machines that combine nested state updates with cross-hierarchy transitions.

  Self-transitions now use deterministic local routes, and layout retries with relaxed port constraints before reporting a failure.

  - @typeonce/effect-machine@0.26.2

## 0.26.1

### Patch Changes

- @typeonce/effect-machine@0.26.1

## 0.26.0

### Minor Changes

- 4130963: Add `@typeonce/oxlint-plugin-effect-machine` with recommended rules for redundant default resolvers, asynchronous planning callbacks, and one-use intermediate `Machine.make(...)` definitions.

  All three Effect Machine packages now release at the same version.

### Patch Changes

- 5edaf24: Improve the static statechart so initial and reachable states follow a stable left-to-right order, reverse and self-transitions use dedicated routes, and transition labels stay clear of arrowheads and compound boundaries.

  Distinguish automatic transitions with dashed lines and correlate invoke outcomes with muted colors for effect, timer, stream, process, and child-machine activities.

  Stack parallel regions into vertical lanes, separate states with no statically known path from the initial state, and make long or intersecting routes easier to follow with rounded corners, edge casing, and direction cues.

  Add a machine analysis inspector that reports declared public events without handlers and state subtrees without a statically known path from the initial configuration.

- Updated dependencies [4130963]
- Updated dependencies [806d2fd]
  - @typeonce/effect-machine@0.26.0

## 0.25.0

### Minor Changes

- 68152cb: Replace the text-tree topology pane with a statically laid-out statechart. State cards expose value fields and invocations, while routed transition edges and compound regions make the machine topology readable without a draggable canvas. Directional colors distinguish incoming from outgoing relationships, and conditional branches with the same source and target share one topology edge while retaining their full details in the inspector. Machine tabs sit above the full-viewport chart, selection remains visible independently from the on-demand floating inspector, and corner zoom and fit controls provide a whole-machine overview.

  `MachineDocument.State` now retains each state's projected value and output schemas. Consumers of serialized documents must accept `schemaVersion: 3` and the new `valueSchema` and `outputSchema` fields.

  Replace planner-backed browser simulation and `MachineSimulator` with the side-effect-free `MachineWalkthrough` module. A walkthrough derives its initial and active configurations entirely from `MachineDocument`, exposes each documented transition branch as an explicit choice, preserves parallel regions, records shallow and deep history, and retains an immutable timeline with cursor-based time travel. Runtime-resolved targets and first-use history remain visible but unavailable instead of executing callbacks or inventing results.

  The browser now presents public machine and event schemas as read-only contracts and uses transition edges for simulation. Targetless transitions render as clickable self-loops, runtime-resolved targets terminate at disabled dashed placeholders, and state nodes remain read-only. Direct choices advance immediately while ambiguous or unavailable branches appear in a compact anchored picker. The bottom dock is reserved for the time-travel timeline. The browser no longer asks for payload values or evaluates initializers, resolvers, guards, updates, automatic callbacks, or invoke outcomes. Migrate programmatic document exploration from `MachineSimulator.start` and `MachineSimulator.send` to `MachineWalkthrough.start`, `MachineWalkthrough.choices`, and `MachineWalkthrough.take`.

### Patch Changes

- @typeonce/effect-machine@0.25.0

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
