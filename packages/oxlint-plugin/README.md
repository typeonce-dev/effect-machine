# Effect Machine Oxlint plugin

`@typeonce/oxlint-plugin-effect-machine` checks Effect Machine definitions for
redundant resolvers, asynchronous planning, and one-use intermediate machine
definitions.

The plugin uses Oxlint's JavaScript plugin interface. Custom JavaScript plugins
are currently alpha in Oxlint, so keep Oxlint and this package on versions that
have been tested together.

## Install

Install the plugin and the matching Effect Machine release:

```sh
pnpm add -D oxlint @typeonce/oxlint-plugin-effect-machine
pnpm add @typeonce/effect-machine
```

All Effect Machine packages use the same version.

## Configure

Load the plugin and its recommended rules from `oxlint.config.ts`:

```ts
import { recommended } from "@typeonce/oxlint-plugin-effect-machine/recommended"
import { defineConfig } from "oxlint"

export default defineConfig({
  jsPlugins: ["@typeonce/oxlint-plugin-effect-machine"],
  rules: recommended
})
```

JSON configurations can list the same rules directly:

```json
{
  "jsPlugins": ["@typeonce/oxlint-plugin-effect-machine"],
  "rules": {
    "effect-machine/no-async-planning-callback": "error",
    "effect-machine/no-redundant-resolve": "error",
    "effect-machine/prefer-inline-handle": "error"
  }
}
```

The rules are syntax-based. They recognize `Machine.make(...)`, direct chained
`.handle(...)` calls, and `.handle(...)` calls on definitions declared in the
same module. They do not resolve a machine definition imported from another
module.

## Rules

### `effect-machine/no-redundant-resolve`

Removes a resolver whose only result is empty default construction:

```ts
// Before
const handlers = {
  Start: (to) => to.full.Running().resolve(({ target }) => target.from())
}

// After `oxlint --fix`
const handlers = {
  Start: (to) => to.full.Running()
}
```

The fixer does not run when the resolver has options, comments, construction
input, or any other work.

### `effect-machine/no-async-planning-callback`

Rejects asynchronous transition, lifecycle, initial, choice, entry, exit, and
invocation-planning callbacks. A machine plans synchronously. Put asynchronous
work in state-owned `invoke` sources instead.

### `effect-machine/prefer-inline-handle`

Reports a private top-level `Machine.make(...)` definition when its only use is
one `.handle(...)` call:

```ts
// Before
const definition = Machine.make({/* ... */})
export const machine = definition.handle({/* ... */})

// After
export const machine = Machine.make({/* ... */}).handle({/* ... */})
```

Definitions that are exported or reused remain valid.
