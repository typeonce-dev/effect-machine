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

Simulation works from the serialized machine document and never runs project code. It advances only when an event has one required direct transition whose target is statically known.

Declinable transitions, conditional branches, parallel transitions, history, and choices return an indeterminate result. Deterministic steps report skipped state updates, runtime effects, raised events, reentry lifecycles, and automatic stabilization instead of pretending to execute them.

## Programmatic modules

The first release publishes three programmatic modules:

- `DevToolsProtocol` defines the versioned worker and browser messages.
- `MachineDocument` defines and constructs the serializable inspection document.
- `MachineSimulator` provides the side-effect-free document simulator.

The project inspector, registry, worker, and local server remain implementation modules. Their interfaces can change without becoming package-level compatibility commitments.
