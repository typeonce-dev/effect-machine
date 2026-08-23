---
"@typeonce/effect-machine": minor
---

Make state construction modes explicit and allow one topology target to replace a retained valued owner atomically.

Valued builders are no longer callable. Replace `target(value)` and nested `builder(value, ...)` calls with `.decoded(value, ...)`; keep `.from(input, ...)` for schema make input. Plain state-update resolvers now expose the decoded owner as `current` and its construction builder as `owner`, replacing the previous `ancestors` plus `target` pattern.

Declare a combined transition with `.updating(ownerSelector)`. The resolver must finish destination construction with `.update(...)`, so the owner replacement cannot be omitted:

```ts
to.local.SavingPlan()
  .updating(to.branch.Ready)
  .resolve(({ current, owner, target }) =>
    target.from({ request }).update(
      owner.decoded(new Ready({ ...current, notice: null }))
    )
  )
```

Transition inspection and retained microsteps now include an `updates` array naming replaced owners.
