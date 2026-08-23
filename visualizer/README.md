# Interactive text visualizer POV

Run the local prototype from the repository root:

```sh
pnpm visualizer
```

The prototype deliberately consumes only the public machine inspection API. To plug in another completed `.handle(...)`
result, replace the exports in `src/example-machine.ts` or import your machine there, then pass it to the renderer in
`src/main.ts`:

```ts
const buildDocument = makeVisualizationDocument<typeof machine, typeof snapshot>(Machine)
const visualization = buildDocument(machine, snapshot)
const tree = visualizationDocumentToTextTree(visualization)
```

The snapshot is optional. Without one, the same structural tree is rendered with every state inactive and without candidate
events. Vite reloads the page as the imported machine changes.
