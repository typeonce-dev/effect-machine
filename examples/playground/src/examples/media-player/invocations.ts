import { Machine } from "@typeonce/effect-machine"
import { Data, Effect, Stream } from "effect"
import { MediaPlayerInternalEvents } from "./definition.ts"
import { type LoudnessSample, type SoundSettings, toAudioSettings } from "./schemas.ts"
import { MediaPlayer, MediaPlayerError } from "./service.ts"

export const loadAudio = (url: string) =>
  Effect.gen(function*() {
    const mediaPlayer = yield* MediaPlayer
    yield* mediaPlayer.load(url)
  })

export const pauseAudio = Effect.gen(function*() {
  const mediaPlayer = yield* MediaPlayer
  yield* mediaPlayer.pause
})

export const playAudio = Effect.gen(function*() {
  const mediaPlayer = yield* MediaPlayer
  yield* mediaPlayer.play
})

export const restartAudio = Effect.gen(function*() {
  const mediaPlayer = yield* MediaPlayer
  yield* mediaPlayer.restart
})

export const applyAudioSettings = (settings: SoundSettings, muted: boolean) =>
  Effect.gen(function*() {
    const mediaPlayer = yield* MediaPlayer
    yield* mediaPlayer.applySettings(toAudioSettings(settings, muted))
  })

type LoudnessProcessState = Data.TaggedEnum<{
  Waiting: {}
  Measured: { readonly sample: LoudnessSample }
  Failed: { readonly failure: MediaPlayerError }
}>

const LoudnessProcessState = Data.taggedEnum<LoudnessProcessState>()

export const analyzeAudio = Machine.logic<LoudnessProcessState, never, void, never, MediaPlayer>({
  initial: LoudnessProcessState.Waiting(),
  run: ({ setState }) =>
    Effect.gen(function*() {
      const mediaPlayer = yield* MediaPlayer

      yield* mediaPlayer.loudness.pipe(
        Stream.runForEach((sample) => setState(LoudnessProcessState.Measured({ sample }))),
        Effect.catch((failure) => setState(LoudnessProcessState.Failed({ failure })).pipe(Effect.andThen(Effect.never)))
      )
    })
})

export const loudnessEvent = (state: LoudnessProcessState) =>
  LoudnessProcessState.$match(state, {
    Waiting: () => undefined,
    Measured: ({ sample }) => MediaPlayerInternalEvents.LoudnessMeasured(sample),
    Failed: ({ failure }) => MediaPlayerInternalEvents.OperationFailed({ message: failure.message })
  })
