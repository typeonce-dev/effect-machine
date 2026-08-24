# Effect Machine devtools

Run the local visualizer from a project that uses Effect Machine:

```sh
effect-machine
```

The command scans `**/src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}` for `.handle(...)` calls, evaluates candidate modules in an isolated worker, and serves the machine index at `http://127.0.0.1:5173`.

Use flags when the project layout or local address differs:

```sh
effect-machine --root ./packages/app --include "src/**/*.ts" --port 4173 --open
```

The page updates after matching source files change. A failed reload keeps the last valid machine document visible as a partial result, with the current diagnostic beside it. Removing a machine export removes it from the index on the next successful scan.

## Evaluation boundary

Discovery is static: it parses source files without executing them. Evaluation loads only candidate modules in a fresh worker and never invokes transition resolvers or activity sources. Module-level code still runs when an exported machine is loaded, so project modules used with the devtools should keep construction free of application side effects.

The visualizer supports topology navigation, state annotations, event inspection, transition branches and updates, activities, keyboard navigation, live reload, and best-effort simulation.

## Simulation boundary

Start a simulation from the topology toolbar, then choose an enabled event. The simulator advances only when the document identifies one required direct transition. It updates the active topology without running project code.

Declinable transitions, conditional branches, history, and choices return an indeterminate result instead of guessing. Deterministic steps explicitly note that runtime effects, state updates, reentry lifecycles, and automatic stabilization were skipped when relevant.
