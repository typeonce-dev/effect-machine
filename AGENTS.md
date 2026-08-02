# Project guidance

A core objective of the library is type safety and ease of use of the user-facing API, for both humans and agents.

The goal is eventually to merge this inside the core of the `effect` library, so plan changes according to the patterns and expectations of `effect`.

Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.

## Verification

Run:

```sh
pnpm check
```

For changes that can affect the public TypeScript API or its inference, also run:

```sh
pnpm perf:types
```

When an example changes, run its own check from the example directory:

```sh
pnpm check
```

Every package directly below `examples/` must have a `check` script and a committed lockfile.

## Pull request conventions

- Add or update a changeset for changes under `src/` or changes to `package.json`.
- Fill in the pull request template, including the validation performed and the changeset decision.
