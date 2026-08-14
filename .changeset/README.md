# Changesets

Run `pnpm changeset` for every user-facing change.

## Writing changelog entries

Changeset descriptions are published directly on the documentation website. Write them for library users rather than repository maintainers.

- Lead with the user-visible outcome and name the affected API when useful.
- Keep the entry short and specific. One to three brief paragraphs is usually enough.
- Use separate paragraphs when they make the outcome, motivation, or migration clearer.
- Use inline code for API names, types, and short expressions.
- Include at most one small fenced TypeScript example when an API is added or its usage changes meaningfully.
- For a breaking change, state what changed and show the replacement or migration directly.
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
