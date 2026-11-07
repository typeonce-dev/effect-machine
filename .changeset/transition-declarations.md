---
"@typeonce/effect-machine": minor
"@typeonce/effect-machine-react": minor
"@typeonce/effect-machine-devtools": minor
"@typeonce/oxlint-plugin-effect-machine": minor
---

Declare conditional transitions inline, with `branches` next to `resolve`, so one transition can be read and edited alone. The compiler checks one against the other in both directions, and rejects a resolver that does not return a `select` call on every path:

```ts
Pay: {
  branches: [{ target: "Charging" }, { update: "root" }, { stay: true }, { decline: true }],
  resolve: ({ event, select }) => {
    if (event.amount < 0) return select.decline()
    if (event.amount === 0) return select.stay()
    return event.preview
      ? select.update({ root: { total: event.amount } })
      : select.target("Charging", { data: { amount: event.amount } })
  }
}
```

To migrate: move each `make({ branches })` group into its transition and drop its keys and `title`, so `select.key(...)` becomes `select.target(path, ...)`, `select.update({ owner: value })`, `select.history(path)`, `select.initialize({ input })`, or `select.stay()`. Two keys that reached the same destination are now one entry. Remove `declinable: true`, list `{ decline: true }`, and replace the `decline()` context function with `select.decline()`.

`none` is replaced: `{ none: true }` becomes `{ stay: true }`, `{ none: true, reenter: true }` becomes `{ reenter: true }`, and `{ none: true, resolve }` becomes `{ stay: true, commands }`. Every plain transition accepts `commands: (context, enqueue) => ...`.

`update` is now a record with one owner, so `data` only ever means the target's value: `{ update: "root", data }` becomes `{ update: { root: data } }`, and `{ target, update: "Owner", data: () => ({ target, update }) }` becomes `{ target, data, update: { Owner: value } }`. Inside a `branches` list, an entry still names its owner as a string, `{ target, update: "Owner" }`, and the value goes in its `select` call.

`guard` and `decline` now exist only on `on` handlers and `always`. On `onDone`, `onFailure`, `onElement`, `onSnapshot`, and `choice`, which have no other candidate, use `{ stay: true }` or select a destination. A retained transition's `branchKey` and a transition definition's `key` are now the entry as written, such as `target:Paid`, and `title` is removed.

In the Oxlint plugin, `no-conditional-none-branch` becomes `no-conditional-stay-branch`, and `no-redundant-resolve` is removed because the compiler now rejects what it reported. Resolvers for invocation outcomes and `always` may select `stay` conditionally, because `Machine.can` queries only events.
