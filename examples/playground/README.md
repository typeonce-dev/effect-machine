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

The turnstile, traffic light, and microwave route components are intentionally
light: their domain schemas, events, and state topology are ready, while the
React-to-machine adapter is left for the exercise.

The media player is a complete browser integration. `schemas.ts` owns its typed
protocol, `service.ts` exposes the audio element and Web Audio graph as an
Effect service, `invocations.ts` defines its state-scoped processes, and the
React adapter registers the audio element through the shared service runtime
before translating playback events into machine events. `view.ts` exhaustively
projects the typed parallel snapshot into the React-facing view model. Its compound
`Ready` state models the loaded playback lifecycle inside a parallel `Player`:
the transport region owns loading, playback, buffering, and failures while the
settings region independently owns `Audible` and `Muted`.

The workers route additionally contains:

- `machine.worker.ts`: Vite's module-worker entry point and the place to start
  the machine runtime.
- `worker-client.ts`: typed worker construction, send, subscribe, and cleanup.
- `tab-channel.ts`: a typed `BroadcastChannel` wrapper for cross-tab messages.
- `protocol.ts`: worker and tab message boundaries.

Vite discovers the worker because `worker-client.ts` constructs it with
`new Worker(new URL("./machine.worker.ts", import.meta.url), { type: "module" })`.
No extra Vite worker plugin is required.
