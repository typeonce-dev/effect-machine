---
"@typeonce/effect-machine": minor
---

Bind started machines to the caller's `Scope`.

`Machine.start`, `Machine.resume`, and `prepared.start` now require `Scope.Scope`, like `Effect.forkScoped`. Closing that scope is equivalent to `ref.stop`: active invocations are interrupted, owned children stop, the snapshot becomes `stopped`, and later sends fail with `StoppedError`. A machine that stops or completes earlier releases its place in the scope, so long-lived scopes do not accumulate finalizers. For `prepared.start`, the scope that first evaluates it owns the machine. `AtomMachine` is unaffected.

Wrap programs that start machines in `Effect.scoped`, or own a scope explicitly when a machine must outlive the caller:

```ts
const program = Effect.scoped(Effect.gen(function*() {
  const ref = yield* Machine.start(machine)
  yield* ref.send(Events.Go())
}))

const detached = Effect.gen(function*() {
  const scope = yield* Scope.make()
  return yield* Machine.start(machine).pipe(Scope.provide(scope))
})
```
