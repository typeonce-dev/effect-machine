# Effect Machine devtools

`@typeonce/effect-machine-devtools` scans a local project for exported Effect Machine `.handle(...)` results and serves a live, statically laid-out statechart.

The package is experimental and pre-1.0. Minor releases may change its command options, document schemas, and programmatic modules.

## Compatibility

Core and devtools always release at the same version. Install matching versions:

```sh
pnpm add @typeonce/effect-machine@latest effect@4.0.0-rc.111
pnpm add --save-dev @typeonce/effect-machine-devtools@latest
```

When pinning a release instead of using `latest`, use the same explicit version for both packages.

The current release requires Node.js 22.19 or newer and Effect `4.0.0-rc.111`.

## Run the visualizer

Start it from the project that contains the machines:

```sh
pnpm exec effect-machine
```

The command scans `**/src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}` and serves the visualizer at `http://127.0.0.1:5173`.

```sh
pnpm exec effect-machine \
  --root ./packages/app \
  --include "src/**/*.ts" \
  --port 4173 \
  --open
```

| Option            | Default                                       | Purpose                                                    |
| ----------------- | --------------------------------------------- | ---------------------------------------------------------- |
| `--root`          | current directory                             | Project directory to inspect                               |
| `--include`       | `**/src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}` | Machine source glob relative to the project root           |
| `--host`          | `127.0.0.1`                                   | Local server host                                          |
| `--port`          | `5173`                                        | Local server port                                          |
| `--open`          | `false`                                       | Open the visualizer in the default browser                 |
| `--watch-polling` | `false`                                       | Use polling when native file-system events are unavailable |

Native file-system events are the default. Polling scans more frequently and may use more CPU in large repositories, so enable it only when the platform watcher misses changes.

## Live results

The browser reports one of these statuses for every candidate:

- `Ready` contains the latest complete machine document.
- `Partial` keeps the last valid document visible and adds diagnostics from the incomplete source.
- `Failed` contains diagnostics when no valid document is available.

An incomplete edit can remove `.handle(...)` or change an export temporarily without discarding the last valid topology. A syntactically valid removal removes the machine from the index on the next scan.

## Trusted projects only

Discovery parses source files without executing them. Evaluation then loads candidate modules in a fresh worker. Module initialization code executes during that load, although transition resolvers and activity sources do not.

Run the devtools only against code you trust. The server has no authentication and binds to the loopback interface by default. Do not expose it on a public or untrusted network.

## Inspection and walkthroughs

The visualizer shows topology as a read-only statechart with native horizontal and vertical scrolling, incremental zoom, and a fit-to-viewport overview. Machine tabs run across the top so the chart uses the rest of the viewport. States remain grouped inside their compound parents, while orthogonal routes connect each enabled transition without requiring a draggable canvas. State cards show projected value fields and invocations at a glance. A single click selects a state or transition, while a double click opens its dismissible inspector. State selection distinguishes incoming from outgoing relationships, and conditional branches with the same source and target share one topology edge while retaining their full details in the inspector.

The machine document includes projected value and output schemas for every state, plus the public machine and event input contracts. The browser renders those contracts as read-only field metadata: names, projected types, required or optional status, descriptions, ranges, lengths, patterns, and literal or enum values. It never asks for payload values merely to explore a static document.

Start a simulation to enter the document's captured configuration or its declared initial topology. Simulation mode turns transition edges into the control surface while state nodes remain read-only. Targetless transitions are rendered as self-loops, and runtime-resolved targets terminate at disabled dashed placeholders. Click an unambiguous available edge to advance directly; ambiguous branches open a compact picker at the click rather than guessing. Parallel regions stay active independently, compound states enter their declared initial child, and recorded shallow or deep history can be restored later in the same simulation.

Conditional branches, declinable transitions, automatic triggers, and invoke outcomes are shown as explicit choices rather than guessed. A runtime-resolved target or first use of an unrecorded history target remains visible but unavailable. Public event contracts are shown beside their choices, but values are not fabricated because no value can change a document-only decision reliably.

Every selected branch is retained in the immutable bottom timeline. Select an earlier step, then choose a different branch on the chart to truncate the old future and explore another path. The chart keeps candidate edges visible and reveals a new active configuration only when it falls outside the viewport.

Simulations do not load project modules again, call resolvers or guards, apply state updates, run Effects, start invocations, deliver events, or commit commands. They are deliberately topology-only and side-effect-free. A file change remounts the latest document; restart the simulation to explore the new revision.

## Programmatic modules

The package publishes three programmatic modules:

- `DevToolsProtocol` defines the versioned discovery and browser registry messages.
- `MachineDocument` defines and constructs the serializable inspection document.
- `MachineWalkthrough` provides immutable, document-only topology exploration with explicit choices, history, and time travel.

The project inspector, registry, worker, and local server remain implementation modules. Their interfaces can change without becoming package-level compatibility commitments.
