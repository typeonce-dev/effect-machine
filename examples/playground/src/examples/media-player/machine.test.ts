import { assert, describe, it } from "@effect/vitest"
import { Machine } from "@typeonce/effect-machine"
import { MachineTest } from "@typeonce/effect-machine/testing"
import { Effect, Graph } from "effect"
import { FastCheck } from "effect/testing"
import { MediaPlayerMachine } from "./machine.ts"

const everyPublicEvent: ReadonlyArray<Machine.Machine.InputEvent<typeof MediaPlayerMachine>> = [
  { _tag: "AudioElementMounted" },
  { _tag: "AudioElementUnmounted" },
  { _tag: "SourceSelected", url: "https://example.com/audio.mp3" },
  { _tag: "PlayRequested" },
  { _tag: "PauseRequested" },
  { _tag: "RestartRequested" },
  { _tag: "VolumeChanged", volume: 0.4 },
  { _tag: "PlaybackRateChanged", playbackRate: 1.5 },
  { _tag: "MuteRequested" },
  { _tag: "UnmuteRequested" }
]

const generated = MachineTest.scenarios(MediaPlayerMachine, {
  eventsArbitrary: FastCheck.array(FastCheck.constantFrom(...everyPublicEvent), { maxLength: 30 })
})

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

const invariant = MachineTest.invariants(MediaPlayerMachine)

const parallelRegionsAreIndependent = invariant.step(
  "session and settings commands stay in their own parallel region",
  ({ after, before, event }) => {
    const sessionUnchanged = same(before.states.session.state, after.states.session.state)
    const settingsUnchanged = same(before.states.settings.state, after.states.settings.state)
    if (["VolumeChanged", "PlaybackRateChanged", "MuteRequested", "UnmuteRequested"].includes(event._tag)) {
      return sessionUnchanged || `settings event ${event._tag} changed the session region`
    }
    return settingsUnchanged || `session event ${event._tag} changed the settings region`
  }
)

const settingsUpdatesAreExact = invariant.step(
  "settings commands preserve unrelated values",
  ({ after, before, event }) => {
    const previous = before.states.settings.state
    const next = after.states.settings.state
    switch (event._tag) {
      case "VolumeChanged":
        return Object.is(next.value.volume, event.volume) &&
            Object.is(next.value.playbackRate, previous.value.playbackRate) ||
          "volume update changed playback rate or stored the wrong volume"
      case "PlaybackRateChanged":
        return Object.is(next.value.playbackRate, event.playbackRate) &&
            Object.is(next.value.volume, previous.value.volume) ||
          "playback-rate update changed volume or stored the wrong rate"
      case "MuteRequested":
        return next.path === "Player.settings.Muted" &&
            Object.is(next.value.volume, previous.value.volume) &&
            Object.is(next.value.playbackRate, previous.value.playbackRate) ||
          "mute did not preserve sound settings"
      case "UnmuteRequested":
        return next.path === "Player.settings.Audible" &&
            Object.is(next.value.volume, previous.value.volume) &&
            Object.is(next.value.playbackRate, previous.value.playbackRate) ||
          "unmute did not preserve sound settings"
      default:
        return true
    }
  }
)

const laws = [parallelRegionsAreIndependent, settingsUpdatesAreExact]

describe("media-player statechart model", () => {
  it.effect.prop(
    "keeps every schema-generated scenario structurally valid",
    { scenario: generated.arbitrary },
    ({ scenario }) =>
      MachineTest.run(MediaPlayerMachine, scenario).pipe(
        Effect.tap((trace) => MachineTest.verify(MediaPlayerMachine, trace)),
        Effect.tap((trace) => MachineTest.assertInvariants(MediaPlayerMachine, trace, laws)),
        Effect.tap((trace) =>
          Effect.sync(() => {
            assert.strictEqual(trace.final.path, "Player")
            assert.strictEqual(trace.final.states.session.state.path.startsWith("Player.session."), true)
            assert.strictEqual(trace.final.states.settings.state.path.startsWith("Player.settings."), true)
          })
        ),
        Effect.asVoid
      ),
    { fastCheck: { numRuns: 100, seed: 24_061 } }
  )

  it.effect("covers the public protocol and its reachable states", () =>
    Effect.gen(function*() {
      const trace = yield* MachineTest.run(MediaPlayerMachine, { events: everyPublicEvent })
      yield* MachineTest.verify(MediaPlayerMachine, trace)

      const coverage = MachineTest.coverage(MediaPlayerMachine, trace)

      assert.strictEqual(coverage.events.hit, everyPublicEvent.length)
      assert.strictEqual(coverage.events.missing, 0)
      assert.strictEqual(coverage.transitions.definitions.hit > 0, true)
      assert.strictEqual(coverage.transitions.branches.hit > 0, true)

      const activated = new Set(coverage.states.activation.hits.map(({ path }) => path))
      assert.strictEqual(activated.has("Player.session.Unregistered"), true)
      assert.strictEqual(activated.has("Player.session.Registered"), true)
      assert.strictEqual(activated.has("Player.session.Registered.Empty"), true)
      assert.strictEqual(activated.has("Player.settings.Audible"), true)
      assert.strictEqual(activated.has("Player.settings.Muted"), true)
    }))

  it.effect("records every planned event in the observed graph", () =>
    Effect.gen(function*() {
      const trace = yield* MachineTest.run(MediaPlayerMachine, { events: everyPublicEvent })
      const observed = yield* MachineTest.observedGraph(MediaPlayerMachine, trace)
      const eventEdges = Array.from(Graph.edges(observed.graph), ([, edge]) => edge).filter(
        ({ data }) => data._tag === "Event"
      )

      assert.strictEqual(Graph.nodeCount(observed.graph) > 1, true)
      assert.strictEqual(Graph.edgeCount(observed.graph), everyPublicEvent.length + 1)
      assert.strictEqual(eventEdges.length, everyPublicEvent.length)
      assert.strictEqual(observed.starts.length, 1)
    }))

  it.effect("explores public behavior and preserves the internal completion boundary", () =>
    Effect.gen(function*() {
      const explored = yield* MachineTest.explore(MediaPlayerMachine, {
        events: () => everyPublicEvent,
        stateKey: ({ snapshot }) =>
          JSON.stringify({
            session: snapshot.states.session.state,
            settings: snapshot.states.settings.state
          }),
        invariants: laws
      })

      assert.deepStrictEqual(explored.completeness, { _tag: "Complete" })

      const registeredAndMuted = yield* MachineTest.assertReachable(
        explored,
        "registered element while muted",
        ({ configuration }) =>
          configuration.includes("Player.session.Registered") &&
          configuration.includes("Player.settings.Muted")
      )
      assert.deepStrictEqual(registeredAndMuted.trace.scenario.events, [
        everyPublicEvent[0],
        { _tag: "MuteRequested" }
      ])

      yield* MachineTest.assertUnreachable(
        explored,
        "transport active while the audio element is unregistered",
        ({ configuration }) =>
          configuration.includes("Player.session.Unregistered") &&
          configuration.some((path) => path.startsWith("Player.session.Registered."))
      )
    }))
})
