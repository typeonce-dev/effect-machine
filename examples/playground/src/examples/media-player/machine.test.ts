import { assert, describe, it } from "@effect/vitest"
import { MachineTest } from "@typeonce/effect-machine/testing"
import { Effect, Graph } from "effect"
import { MediaPlayerEvent, MediaPlayerMachine } from "./machine.ts"

const everyPublicEvent = [
  MediaPlayerEvent.cases.SourceSelected.make({ url: "https://example.com/audio.mp3" }),
  MediaPlayerEvent.cases.PlayRequested.make({}),
  MediaPlayerEvent.cases.PauseRequested.make({}),
  MediaPlayerEvent.cases.MediaPlaying.make({}),
  MediaPlayerEvent.cases.MediaPaused.make({}),
  MediaPlayerEvent.cases.MediaWaiting.make({}),
  MediaPlayerEvent.cases.MediaCanPlay.make({}),
  MediaPlayerEvent.cases.MediaEnded.make({}),
  MediaPlayerEvent.cases.MediaFailed.make({ message: "unsupported codec" }),
  MediaPlayerEvent.cases.VolumeChanged.make({ volume: 0.4 }),
  MediaPlayerEvent.cases.MuteToggled.make({})
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
            assert.strictEqual(trace.final.states.playback.state.path, "Player.playback.Empty")
            const volume = trace.final.states.volume.state
            if (volume.path !== "Player.volume.Audible") {
              throw new Error(`Expected Audible, received ${volume.path}`)
            }
            assert.strictEqual(volume.value.volume, 1)
          })
        ),
        Effect.asVoid
      ),
    { fastCheck: { numRuns: 100, seed: 24_061 } }
  )

  it.effect("makes the current behavior gaps explicit through coverage", () =>
    Effect.gen(function*() {
      const trace = yield* MachineTest.run(MediaPlayerMachine, { events: everyPublicEvent })
      yield* MachineTest.verify(MediaPlayerMachine, trace)

      const coverage = MachineTest.coverage(MediaPlayerMachine, trace)

      assert.strictEqual(coverage.events.missing, 0)
      assert.strictEqual(coverage.events.hit, everyPublicEvent.length)
      assert.strictEqual(coverage.transitions.total, 0)
      assert.strictEqual(coverage.logicalConfigurations.hit, 1)
      assert.deepStrictEqual(coverage.states.activation.hits.map(({ path }) => path), [
        "Player",
        "Player.playback",
        "Player.playback.Empty",
        "Player.volume",
        "Player.volume.Audible"
      ])
      assert.deepStrictEqual(coverage.states.activation.misses.map(({ path }) => path), [
        "Player.playback.Loading",
        "Player.playback.Paused",
        "Player.playback.Playing",
        "Player.playback.Buffering",
        "Player.playback.Ended",
        "Player.playback.Failed",
        "Player.volume.Muted"
      ])
    }))

  it.effect("records ignored events without inventing new logical configurations", () =>
    Effect.gen(function*() {
      const trace = yield* MachineTest.run(MediaPlayerMachine, { events: everyPublicEvent })
      const observed = yield* MachineTest.observedGraph(MediaPlayerMachine, trace)
      const eventEdges = Array.from(Graph.edges(observed.graph), ([, edge]) => edge).filter(
        ({ data }) => data._tag === "Event"
      )

      assert.strictEqual(Graph.nodeCount(observed.graph), 1)
      assert.strictEqual(Graph.edgeCount(observed.graph), everyPublicEvent.length + 1)
      assert.strictEqual(eventEdges.length, everyPublicEvent.length)
      assert.strictEqual(eventEdges.every(({ source, target }) => source === target), true)
      assert.strictEqual(observed.starts.length, 1)

      const node = Array.from(observed.graph)[0]![1]
      assert.deepStrictEqual(node.configuration, [
        "Player",
        "Player.playback",
        "Player.playback.Empty",
        "Player.volume",
        "Player.volume.Audible"
      ])
    }))
})
