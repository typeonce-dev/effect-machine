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
initialization, output, history fallback, and invocation declaration
callbacks. A nested invocation source is state-owned work and is not treated
as planning.

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

Resolver-only reentry uses `.reenter()`:

```ts
// Before
to.local.Ready().resolve(({ target }) => target.from(), { reenter: true })

// After `oxlint --fix`
to.local.Ready().reenter()
```

An empty `to.none.resolve(() => {})` is similarly reduced to `to.none`.

### `effect-machine/no-async-planning-callback`

Rejects `async` planning callbacks and direct Promise, fetch, timer, or
scheduling operations during planning. A machine plans synchronously and has
no lifetime in which to own work started by a transition.

```ts
// Incorrect: the transition starts unowned work.
const incorrect = {
  Submit: (to) => {
    fetch("/orders", { method: "POST" })
    return to.full.Complete()
  }
}

// Correct: the state owns and cancels the work.
const correct = {
  Submitting: {
    invoke: (from) =>
      from.effect("submit-order", () => submitOrder())
        .onDone((to) => to.full.Complete())
        .onFailure((to) => to.full.Failed())
  }
}
```

The rule only reports known unshadowed globals. Calls inside the source passed
to `from.effect`, `from.stream`, or another invocation builder remain valid.

### `effect-machine/no-conflicting-invocation-identity`

Requires every invocation declared by one state to have a unique lifecycle ID
and every concurrently owned logic or child process to have a unique runtime
address.

```ts
// Incorrect: both outcomes use the "load" lifecycle ID.
const incorrect = {
  invoke: (from) => [
    from.effect("load", loadAccount),
    from.timer("load", "10 seconds")
  ]
}

// Correct
const correct = {
  invoke: (from) => [
    from.effect("load-account", loadAccount),
    from.timer("load-timeout", "10 seconds")
  ]
}
```

Duplicate lifecycle IDs make outcome routing ambiguous. Duplicate active
addresses fail at runtime. If two operations must run sequentially, put them
in separate states and transition from the first invocation's outcome instead
of relying on completion timing.

The rule compares only identities it can prove equal, such as literals, the
same binding, static `Machine.childAddress(...)` values, and local
`Machine.child(...)` descriptors. It checks one state's invocation declaration
at a time and does not guess whether separate states can be active together.

### `effect-machine/no-browser-api-in-planning`

Rejects direct access to stateful browser APIs such as `document`,
`localStorage`, `navigator`, `location`, workers, and browser event APIs during
planning.

```ts
// Incorrect: transition planning reads ambient storage.
const incorrect = {
  Restore: (to) =>
    localStorage.getItem("draft") === null
      ? to.full.Empty()
      : to.full.Editing()
}

// Correct: state-owned work reads storage and reports an outcome.
const correct = {
  Restoring: {
    invoke: (from) =>
      from.effect("restore-draft", () => restoreDraft())
        .onDone((to) => to.full.Editing())
        .onFailure((to) => to.full.Empty())
  }
}
```

If browser work affects the workflow, move it into a state-owned invocation.
If it only focuses, measures, or renders UI, keep it in the UI adapter. Pure
data utilities such as `URL`, `URLSearchParams`, `TextEncoder`, and
`structuredClone` are not reported.

### `effect-machine/no-nondeterministic-planning`

Rejects direct reads of ambient time or randomness during planning, including
`Date.now()`, zero-argument `new Date()`, `Math.random()`, crypto randomness,
performance clocks, `Temporal.Now`, and process clocks.

```ts
// Incorrect: the same event and snapshot can select different results.
const incorrect = {
  Check: (to) =>
    Date.now() >= deadline
      ? to.full.Expired()
      : to.none
}

// Correct: receive the external fact as part of the event protocol.
const correct = {
  Check: (to) =>
    to.branches({
      expired: { target: to.full.Expired() },
      current: { target: to.full.Current() }
    }).resolve(({ event, select }) =>
      event.now >= event.deadline
        ? select.expired.from()
        : select.current.from()
    )
}
```

Pass the value through machine input or an event when it is already known. If
the machine must obtain it, produce it in a state-owned invocation and
transition from the invocation outcome. Deterministic operations such as
`new Date(event.timestamp)` and `Date.parse(state.createdAt)` remain valid.

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
