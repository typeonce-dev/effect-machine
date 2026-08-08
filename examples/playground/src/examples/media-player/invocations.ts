import { Machine } from "@typeonce/effect-machine"
import { Data, Effect, Stream } from "effect"
import { type LoudnessSample, MediaPlayerInternalEvent } from "./schemas.ts"
import { MediaPlayer, MediaPlayerError } from "./service.ts"

export const loadAudio = (url: string) =>
  Machine.invokeEffect({
    id: "load-audio",
    effect: Effect.gen(function*() {
      const mediaPlayer = yield* MediaPlayer
      yield* mediaPlayer.load(url)
    }),
    onSuccess: () => MediaPlayerInternalEvent.cases.LoadSucceeded.make({}),
    onFailure: (failure) => MediaPlayerInternalEvent.cases.OperationFailed.make({ message: failure.message })
  })

export const pauseAudio = Machine.invokeEffect({
  id: "pause-audio",
  effect: Effect.gen(function*() {
    const mediaPlayer = yield* MediaPlayer
    yield* mediaPlayer.pause
  }),
  onSuccess: () => undefined,
  onFailure: (failure) => MediaPlayerInternalEvent.cases.OperationFailed.make({ message: failure.message })
})

export const playAudio = Machine.invokeEffect({
  id: "play-audio",
  effect: Effect.gen(function*() {
    const mediaPlayer = yield* MediaPlayer
    yield* mediaPlayer.play
  }),
  onSuccess: () => undefined,
  onFailure: (failure) => MediaPlayerInternalEvent.cases.OperationFailed.make({ message: failure.message })
})

export const restartAudio = Machine.invokeEffect({
  id: "restart-audio",
  effect: Effect.gen(function*() {
    const mediaPlayer = yield* MediaPlayer
    yield* mediaPlayer.restart
  }),
  onSuccess: () => MediaPlayerInternalEvent.cases.RestartSucceeded.make({}),
  onFailure: (failure) => MediaPlayerInternalEvent.cases.OperationFailed.make({ message: failure.message })
})

type LoudnessProcessState = Data.TaggedEnum<{
  Waiting: {}
  Measured: { readonly sample: LoudnessSample }
  Failed: { readonly failure: MediaPlayerError }
}>

const LoudnessProcessState = Data.taggedEnum<LoudnessProcessState>()

export const analyzeAudio = Machine.invoke({
  id: "analyze-audio",
  src: () =>
    Machine.logic<LoudnessProcessState, never, void, never, MediaPlayer>({
      initial: LoudnessProcessState.Waiting(),
      run: ({ setState }) =>
        Effect.gen(function*() {
          const mediaPlayer = yield* MediaPlayer

          yield* mediaPlayer.loudness.pipe(
            Stream.runForEach((sample) => setState(LoudnessProcessState.Measured({ sample }))),
            Effect.catch((failure) =>
              setState(LoudnessProcessState.Failed({ failure })).pipe(Effect.andThen(Effect.never))
            )
          )
        })
    }),
  snapshot: ({ snapshot }) =>
    LoudnessProcessState.$match(snapshot.state, {
      Waiting: () => undefined,
      Measured: ({ sample }) => MediaPlayerInternalEvent.cases.LoudnessMeasured.make(sample),
      Failed: ({ failure }) => MediaPlayerInternalEvent.cases.OperationFailed.make({ message: failure.message })
    })
})
