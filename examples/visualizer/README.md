# Effect Machine visualizer experiment

This example is an external planner sandbox built only from public machine APIs. It renders static state and transition
definitions, highlights the active configuration, and plans concrete public events without running deferred actions or
invoked services.

Named event fixtures are preferred when payload semantics matter. Missing public event cases receive deterministic
schema-generated samples through `Schema.toArbitrary` and `fast-check`.

```sh
pnpm install
pnpm dev
```

Use `pnpm check` to run the controller tests, typecheck the example, and build the page.
