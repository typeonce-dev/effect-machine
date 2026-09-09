# Effect Machine Oxlint plugin

`@typeonce/oxlint-plugin-effect-machine` checks Effect Machine definitions for
invalid invocation identities, impure planning, redundant resolvers, and
one-use intermediate machine definitions.

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
    "effect-machine/no-browser-api-in-planning": "error",
    "effect-machine/no-conflicting-invocation-identity": "error",
    "effect-machine/no-nondeterministic-planning": "error",
    "effect-machine/no-redundant-resolve": "error",
    "effect-machine/prefer-inline-handle": "error"
  }
}
```

The rules are syntax-based and deliberately conservative. They recognize
`Machine.make(...)`, direct chained `.handle(...)` calls, and `.handle(...)`
calls on definitions declared in the same module. They do not resolve an
imported machine definition or guess the result of an arbitrary function call.

Planning checks cover initial, transition, resolution, lifecycle, choice,
initialization, output, history fallback, and invocation input callbacks.
Registered source programs are state-owned work and are not treated as planning.

## Rules

### `effect-machine/no-redundant-resolve`

An empty targetless resolver has no work to do:

```ts
// Before
Ignore: { none: true, resolve: () => {} }
// After oxlint --fix
Ignore: { none: true }
```

The fixer preserves callbacks with comments or meaningful work. Ordinary
transitions with default construction use `{ target: targets.root.Ready }`.

### `effect-machine/no-async-planning-callback`

Rejects asynchronous work in transition construction, guards, resolvers,
lifecycle handlers, root and initial data constructors, and invocation input mappers. Register lazy
Effects and Streams in `make`, then let a state invoke them:

```ts
// In make: effects: { submitOrder }
Submitting: {
  invoke: {
    src: "submitOrder",
    input: ({ state }) => state.order,
    onDone: { target: targets.root.Complete, data: ({ output }) => ({ order: output }) },
    onFailure: { target: targets.root.Failed, data: ({ error }) => ({ message: String(error) }) }
  }
}
```

Source programs may perform asynchronous work. Input mappers only select
inputs synchronously. The rule reports known unshadowed globals, not arbitrary
function calls whose behavior it cannot determine.

### `effect-machine/no-conflicting-invocation-identity`

Invocations on one state require unique lifecycle IDs. Effects, Streams, and
timers default their ID to `src`; an explicit `id` overrides it. Logic and child
processes also require unique addresses while active.

```ts
// Incorrect: both declarations explicitly use the same ID.
invoke: ;
;[
  { src: "loadAccount", id: "load", ...accountOutcomes },
  { src: "loadTimeout", id: "load", ...timeoutOutcomes }
]

// Correct: distinct registered source names supply distinct default IDs.
invoke: ;
;[
  { src: "loadAccount", ...accountOutcomes },
  { src: "loadTimeout", ...timeoutOutcomes }
]
```

The rule resolves static literals, local bindings, `Machine.childAddress`, and
child descriptors registered in the same module's `make` call. It checks one
state's invocation array at a time. Runtime validation also checks concurrent
ownership; use separate states when two lifecycles must run sequentially.

### `effect-machine/no-browser-api-in-planning`

Rejects ambient browser access such as `localStorage`, `document`, `navigator`,
and event APIs from planning callbacks. Obtain external facts in registered
Effects and pass their results through invocation outcomes. Keep purely visual
work such as focusing or measuring elements in the UI adapter.

Pure data utilities such as `URL`, `URLSearchParams`, `TextEncoder`, and
`structuredClone` remain valid.

### `effect-machine/no-nondeterministic-planning`

Rejects ambient time and randomness in planning callbacks, including
`Date.now()`, zero-argument `new Date()`, `Math.random()`, and crypto randomness.
Receive facts through events or machine input, or obtain them in invoked work:

```ts
// In make:
branches: {
  expiry: {
    expired: { target: targets.root.Expired },
    current: { none: true }
  }
}

// In handle:
Check: {
  branches: "expiry",
  resolve: ({ event, select }) => event.now >= event.deadline
    ? select.expired.from()
    : select.current()
}
```

Deterministic operations such as `new Date(event.timestamp)` and
`Date.parse(state.createdAt)` remain valid.

### `effect-machine/prefer-inline-handle`

Reports a private top-level `Machine.make(...)` definition when its only use is
one `.handle(...)` call:

```ts
// Before
const definition = Machine.make({/* ... */})
export const machine = definition.handle({ states: {/* ... */} })

// After
export const machine = Machine.make({/* ... */}).handle({ states: {/* ... */} })
```

Definitions that are exported or reused remain valid.
