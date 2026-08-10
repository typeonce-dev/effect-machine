import { assert, describe, it } from "@effect/vitest"
import { MachineTest } from "@typeonce/effect-machine/testing"
import { Effect, Graph } from "effect"
import { MediaPlayerMachine } from "./machine.ts"
import { MediaPlayerEvent } from "./schemas.ts"

const everyPublicEvent = [
  MediaPlayerEvent.cases.SourceSelected.make({ url: "https://example.com/audio.mp3" }),
  MediaPlayerEvent.cases.PlayRequested.make({}),
  MediaPlayerEvent.cases.PauseRequested.make({}),
  MediaPlayerEvent.cases.RestartRequested.make({}),
  MediaPlayerEvent.cases.MediaWaiting.make({}),
  MediaPlayerEvent.cases.MediaCanPlay.make({}),
  MediaPlayerEvent.cases.PlaybackEnded.make({ currentTime: 42 }),
  MediaPlayerEvent.cases.TimeUpdated.make({ currentTime: 21 }),
  MediaPlayerEvent.cases.MediaFailed.make({ message: "unsupported codec" }),
  MediaPlayerEvent.cases.VolumeChanged.make({ volume: 0.4 }),
  MediaPlayerEvent.cases.PlaybackRateChanged.make({ playbackRate: 1.5 }),
  MediaPlayerEvent.cases.MuteRequested.make({}),
  MediaPlayerEvent.cases.UnmuteRequested.make({})
]

const generated = MachineTest.scenarios(MediaPlayerMachine, {
  minEvents: 0,
  maxEvents: 30
})

describe("media-player statechart model", () => {
  it.effect.prop(
    "keeps every schema-generated scenario structurally valid",
    { scenario: generated.arbitrary },
    ({ scenario }) =>
      MachineTest.run(MediaPlayerMachine, scenario).pipe(
        Effect.tap((trace) => MachineTest.verify(MediaPlayerMachine, trace)),
        Effect.tap((trace) =>
          Effect.sync(() => {
            assert.strictEqual(trace.final.path, "Player")
            assert.strictEqual(trace.final.states.transport.state.path.startsWith("Player.transport."), true)
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
      assert.strictEqual(coverage.transitions.hit > 0, true)

      const activated = new Set(coverage.states.activation.hits.map(({ path }) => path))
      assert.strictEqual(activated.has("Player.transport.Empty"), true)
      assert.strictEqual(activated.has("Player.transport.Loading"), true)
      assert.strictEqual(activated.has("Player.transport.Failed"), true)
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
})
