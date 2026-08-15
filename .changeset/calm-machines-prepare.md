---
"@typeonce/effect-machine": minor
---

Add `Machine.prepare` for composing snapshot and emission streams before a machine initializes, while keeping `Machine.start` as the one-step convenience.

```ts
const prepared = yield * Machine.prepare(machine)
yield * prepared.emissions.pipe(
  Stream.runForEach(handleEmission),
  Effect.forkScoped({ startImmediately: true })
)
const ref = yield * prepared.start
```

AtomMachine emission streams use the same preparation boundary, and machine definitions now expose `definition.invoke(...)` so invocation `self` and `parent` references use the exact public input and `parentEvents` protocols.
