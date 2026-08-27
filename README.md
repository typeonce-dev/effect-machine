# @typeonce/effect-machine

Effect-native, schema-first, completely type-safe state machines and statecharts, inspired by [XState](https://github.com/statelyai/xstate).

> The goal of `effect-machine` is to become a core [effect](https://github.com/Effect-TS/effect) module.
>
> It originates from [the following PR](https://github.com/Effect-TS/effect/pull/6429#issuecomment-5109812313).

## Quick look

```ts
import { Machine } from "@typeonce/effect-machine"
import { Effect, Schema } from "effect"

const States = Machine.states({
  Locked: {},
  Unlocked: {}
})

const Events = Machine.events(
  Schema.TaggedUnion({
    Coin: {},
    Push: {}
  })
)

const Turnstile = Machine.make({
  id: "Turnstile",
  states: States.states,
  events: Events,
  initial: (to) => to.Locked()
}).handle({
  Locked: {
    on: { Coin: (to) => to.full.Unlocked() }
  },
  Unlocked: {
    on: { Push: (to) => to.full.Locked() }
  }
})

const program = Effect.gen(function*() {
  const ref = yield* Machine.start(Turnstile)
  yield* ref.send(Events.Coin())
})
```

State and event schemas define the protocol. The handler tree defines the
statechart, and the result runs as an Effect-managed machine.

## Packages

The workspace publishes three packages at the same version:

- [`@typeonce/effect-machine`](./packages/effect-machine/README.md) contains the machine runtime, testing modules, and documentation.
- [`@typeonce/effect-machine-devtools`](./packages/devtools/README.md) contains the publishable local machine visualizer and CLI.
- [`@typeonce/oxlint-plugin-effect-machine`](./packages/oxlint-plugin/README.md) checks Effect Machine models for common structural mistakes.

Install matching versions so the runtime, devtools, and lint rules stay aligned.

---

[XState](https://github.com/statelyai/xstate) is the project's main inspiration and reference for statechart semantics and API coverage.

Direct API comparisons exposed gaps in Effect Machine, and benchmarks against XState drove many runtime performance improvements. `effect-machine` is **not** a direct XState replacement.
