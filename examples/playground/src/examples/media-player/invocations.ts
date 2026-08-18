import { Effect, Stream } from "effect"
import { type SoundSettings, toAudioSettings } from "./schemas.ts"
import { MediaPlayer } from "./service.ts"

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

export const analyzeAudio = Stream.unwrap(
  Effect.map(MediaPlayer, (mediaPlayer) => mediaPlayer.loudness)
)
