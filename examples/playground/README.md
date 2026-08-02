# Effect Machine examples playground

A React and Vite workspace with TanStack Router routes for implementing small
`@typeonce/effect-machine` examples.

## Run it

From this directory:

```sh
pnpm install
pnpm dev
```

Build and type-check with:

```sh
pnpm check
```

## Starters

Each starter keeps its machine definition next to its route component:

- `src/examples/turnstile`
- `src/examples/traffic-light`
- `src/examples/microwave`
- `src/examples/media-player`
- `src/examples/worker-tabs`

The first four route components are intentionally light: their domain schemas,
events, and state topology are ready, while the React-to-machine adapter is left
for the exercise.

The workers route additionally contains:

- `machine.worker.ts`: Vite's module-worker entry point and the place to start
  the machine runtime.
- `worker-client.ts`: typed worker construction, send, subscribe, and cleanup.
- `tab-channel.ts`: a typed `BroadcastChannel` wrapper for cross-tab messages.
- `protocol.ts`: worker and tab message boundaries.

Vite discovers the worker because `worker-client.ts` constructs it with
`new Worker(new URL("./machine.worker.ts", import.meta.url), { type: "module" })`.
No extra Vite worker plugin is required.
