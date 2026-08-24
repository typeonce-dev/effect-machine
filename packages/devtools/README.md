# Interactive text visualizer

Run the local prototype from the repository root:

```sh
pnpm visualizer
```

Replace the exports in `src/internal/browser/example-machine.ts` with another completed `.handle(...)` result. The browser
reloads when the imported machine changes.

The current entry point has three steps:

```ts
const buildDocument = makeVisualizationDocument<typeof machine, typeof snapshot>(Machine)
const visualization = buildDocument(machine, snapshot)
mountVisualizer(root, { status: "ready", document: visualization })
```

The snapshot is optional. Without one, the tree renders the complete topology without active-state or enabled-event markers.

## Interaction model

- The main tree contains states only. Initial, parallel, history, final, transition-count, and activity-count markers keep the
  topology readable without mixing behavior into the hierarchy.
- Selecting a state opens its outgoing transitions, incoming transitions, branches, updates, and activities in the inspector.
- State paths in breadcrumbs, transition targets, update owners, and incoming sources navigate back into the tree.
- Enabled events open an event-centric transition inspection. `Reveal active` selects the deepest active state.
- Arrow keys move through visible states. Left and right collapse or expand a branch. Enter or Space selects it. Escape clears
  the current inspection.

## Input states

`mountVisualizer` accepts ready, partial, and error sources. A partial source keeps the available topology visible and shows its
diagnostics. An error source renders the failure in place. This interface is intended for the later codebase scanner and live
reload process.

The direct prototype imports a completed machine, so a failure thrown while importing that module still belongs to Vite. The
future scanner must catch module-loading failures before it calls `mountVisualizer`.

The original text renderer remains covered by an exact-output parity test through the same serializable visualization document.
