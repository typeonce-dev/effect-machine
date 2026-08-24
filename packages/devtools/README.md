# Effect Machine devtools

`@typeonce/effect-machine-devtools` scans a local project for exported Effect Machine `.handle(...)` results and serves a live text-tree visualizer.

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

## Inspection and simulation

The visualizer shows topology, active initial paths, state annotations, events, transitions, branches, state updates, activities, source metadata, and diagnostics. The tree supports pointer and keyboard navigation, subtree expansion, related-state highlighting, and structured detail inspection.

Simulation uses the same `Machine.planInitial` and `Machine.plan` semantics as the core package. Machine input and event payload controls are derived from their Effect schemas. Fields show their projected type, description, required or optional status, and constraints such as ranges, lengths, patterns, enum choices, and defaults. Supported controls include strings, numbers, booleans, enums, literals, nested objects, arrays, and unions. Browser constraints provide immediate feedback, then Effect Schema validates the complete value in the worker and reports failures beside the corresponding fields.

Start a session, send an enabled event, and inspect the resulting macrostep as structured microsteps. Events without payload fields run when clicked; events with input open a form first. The trace includes selected branches, before/after topology, exits, entries, state updates, raised events, emitted events, planned commands, completion, and output.

Each plan loads the exported machine in a fresh worker, decodes the portable session snapshot, and evaluates synchronous statechart callbacks. This supports conditional branches, parallel transitions, history, choices, state updates, reentry, and automatic stabilization. It also means synchronous code inside initial, transition, entry, exit, choice, history, and output callbacks runs during planning.

The planner does not commit commands, start activities, invoke children, deliver `sendTo` events, or run returned Effects. Commands and emissions are shown in the trace instead. A worker is discarded after every request and a planning request is limited to ten seconds, but the devtools are still intended only for trusted projects.

Simulation sessions use encoded snapshots and are tied to one source revision. A file change remounts the latest document; restart the simulation to use the new definition. Schema decoding and planning failures remain visible as diagnostics without discarding the topology.

## Programmatic modules

The first release publishes three programmatic modules:

- `DevToolsProtocol` defines the versioned worker, browser, and planner-session messages.
- `MachineDocument` defines and constructs the serializable inspection document.
- `MachineSimulator` provides the conservative, document-only simulator for consumers that cannot load project code.

The project inspector, registry, worker, and local server remain implementation modules. Their interfaces can change without becoming package-level compatibility commitments.
