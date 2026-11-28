import { Clock, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity"
import type { Machine } from "../../../../src/index.js"
import { AtomMachine } from "../../../../src/unstable/reactivity/index.js"
import type { Answer, Host, Outcome } from "../host.js"
import { decode, encode, fiberScheduling, renderFailure } from "../host.js"
import { answerOf, capabilities, outcomeOf } from "./local.js"

/** A bridge whose types do not matter to the suite. */
type AnyBridge = AtomMachine.MachineAtom<any, any, any, any, any, any>

/**
 * A host over `AtomMachine` in a real registry. Everything goes through atoms:
 * events are written to `send`, and states are read from `snapshot`.
 */
export const atomHost: Host = {
  name: "AtomMachine",
  capabilities,
  start: Effect.fnUntraced(function*({ activity, input, machine }) {
    const scope = yield* Effect.scope
    const bound = AtomMachine.bind(Atom.runtime(Layer.succeed(Clock.Clock, yield* Clock.Clock)))
    const states: Array<Machine.Machine.EncodedSnapshot> = []
    const emitted: Array<unknown> = []

    const open = Effect.fnUntraced(function*(bridge: AnyBridge) {
      const registry = AtomRegistry.make()
      const emissions = yield* AtomMachine.emissions(bridge).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            emitted.push(event)
          })
        ),
        Effect.provideService(AtomRegistry.AtomRegistry, registry),
        Effect.ignore,
        Effect.forkIn(scope, { startImmediately: true })
      )
      const release = registry.subscribe(bridge.snapshot, (result) => {
        if (AsyncResult.isSuccess(result) && result.value.status !== "stopped") {
          states.push(encode(machine, result.value.state))
        }
      }, { immediate: true })
      return {
        bridge,
        registry,
        close: Effect.andThen(
          Fiber.interrupt(emissions),
          Effect.sync(() => {
            release()
            registry.dispose()
          })
        )
      }
    })

    let opened = yield* open((bound.make as any)(machine, ...input))
    yield* Effect.addFinalizer(() => Effect.suspend(() => opened.close))

    const outcome = (): Outcome => {
      const result = opened.registry.get(opened.bridge.snapshot)
      if (AsyncResult.isSuccess(result)) return outcomeOf(result.value)
      return AsyncResult.isFailure(result)
        ? { _tag: "Failed", failure: renderFailure(result.cause) }
        : { _tag: "Running" }
    }
    const scheduling = fiberScheduling(activity)
    return {
      ...scheduling,
      states,
      emitted,
      current: () => states.at(-1),
      send: (event) =>
        Effect.suspend(() => {
          const { bridge, registry } = opened
          registry.set(bridge.send, event)
          return Effect.map(
            Effect.exit(AtomRegistry.getResult(registry, bridge.send, { suspendOnWaiting: true })),
            (exit): Answer => answerOf(exit as Exit.Exit<void, Machine.StoppedError>)
          )
        }),
      outcome: Effect.sync(outcome),
      stop: Effect.sync(() => opened.registry.set(opened.bridge.stop, undefined)),
      restart: Effect.fnUntraced(function*(downtimeMillis) {
        const stored = states.at(-1)!
        yield* opened.close
        yield* scheduling.advance(downtimeMillis)
        opened = yield* open((bound.resume as any)(machine, decode(machine, stored)))
      })
    }
  })
}
