# Changesets

Run `pnpm changeset` for every user-facing change.

## Pre-1.0 versioning

Effect Machine is experimental and pre-1.0. Use only:

- `minor` for a public addition or breaking API change;
- `patch` for a compatible fix or implementation improvement that requires a changeset.

Do not create a major changeset before 1.0. Backward compatibility is not a design goal during this phase: prefer the clearest long-term API and provide a direct migration instead of adding deprecated aliases or compatibility wrappers.

## Synchronized package versions

`@typeonce/effect-machine`, `@typeonce/effect-machine-react`, `@typeonce/effect-machine-devtools`, and `@typeonce/oxlint-plugin-effect-machine` belong to the same Changesets fixed group. Keep their package versions equal and use `workspace:^` for package dependencies on core. A release affecting any package publishes all four at the same version, so users can select compatible packages by matching their versions.

## Writing changelog entries

Changeset descriptions are published directly on the documentation website. Write them for library users rather than repository maintainers.

- Lead with the user-visible outcome and name the affected API when useful.
- Keep the entry short and specific. One to three brief paragraphs is usually enough.
- Use separate paragraphs when they make the outcome, motivation, or migration clearer.
- Use inline code for API names, types, and short expressions.
- Include at most one small fenced TypeScript example when an API is added or its usage changes meaningfully.
- For a breaking change, state what changed and show the replacement or migration directly.
- Describe the resulting API rather than the external library that inspired it.
- Omit commit hashes, pull request numbers, implementation history, test details, and internal refactoring unless they affect users.

A typical API entry looks like:

````md
Add `Machine.example` for describing the user-visible behavior.

Use it when a short explanation would not make the new calling pattern clear:

```ts
const value = Machine.example(input)
```
````

Prefer a shorter entry without an example for fixes and internal improvements:

```md
Fix resumed machines so nested history is restored before raised events are processed.

This preserves the same observable transition order as a freshly started machine.
```
