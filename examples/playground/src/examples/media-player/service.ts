import { Context, Data, Effect, Fiber, Layer, Option, Ref, Schedule, ScopedRef, Stream, SynchronizedRef } from "effect"

export interface AudioSettings {
  readonly volume: number
  readonly muted: boolean
  readonly playbackRate: number
}

export interface LoudnessSample {
  readonly rms: number
  readonly peak: number
  readonly decibels: number
}

export class MediaPlayerError extends Data.TaggedError("MediaPlayerError")<{
  readonly operation: "register" | "observe" | "load" | "play" | "pause" | "restart" | "analyze"
  readonly message: string
}> {}

type MediaElementEvent = Data.TaggedEnum<{
  Waiting: {}
  CanPlay: {}
  Ended: { readonly currentTime: number }
  TimeUpdated: { readonly currentTime: number }
  Failed: { readonly message: string }
}>

const MediaElementEvent = Data.taggedEnum<MediaElementEvent>()

type AudioGraph = Data.TaggedEnum<{
  Registered: {
    readonly audioRef: HTMLAudioElement
  }
  Loaded: {
    readonly audioRef: HTMLAudioElement
    readonly audioContext: AudioContext
    readonly trackSource: MediaElementAudioSourceNode
    readonly analyserNode: AnalyserNode
  }
}>

const AudioGraph = Data.taggedEnum<AudioGraph>()

interface AudioSession {
  readonly graph: SynchronizedRef.SynchronizedRef<AudioGraph>
}

const fail = (
  operation: MediaPlayerError["operation"],
  message: string
): Effect.Effect<never, MediaPlayerError> => Effect.fail(new MediaPlayerError({ operation, message }))

export class MediaPlayer extends Context.Service<MediaPlayer>()(
  "effect-machine/playground/MediaPlayer",
  {
    make: Effect.gen(function*() {
      const settingsRef = yield* Ref.make<AudioSettings>({ volume: 1, muted: false, playbackRate: 1 })
      const sessionRef = yield* ScopedRef.make<Option.Option<AudioSession>>(() => Option.none())

      const session = (operation: MediaPlayerError["operation"]) =>
        ScopedRef.get(sessionRef).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => fail(operation, "The audio element is not registered"),
              onSome: Effect.succeed
            })
          )
        )

      const applySettings = (audioRef: HTMLAudioElement, settings: AudioSettings) =>
        Effect.sync(() => {
          audioRef.volume = settings.volume
          audioRef.muted = settings.muted
          audioRef.playbackRate = settings.playbackRate
        })

      const resume = (audioContext: AudioContext, operation: "play" | "restart") =>
        audioContext.state === "suspended"
          ? Effect.tryPromise({
            try: () => audioContext.resume(),
            catch: () => new MediaPlayerError({ operation, message: "The audio context could not be resumed" })
          })
          : Effect.void

      return {
        register: (audioRef: HTMLAudioElement | null) =>
          ScopedRef.set(
            sessionRef,
            audioRef === null
              ? Effect.succeed(Option.none())
              : Effect.acquireRelease(
                Effect.gen(function*() {
                  yield* applySettings(audioRef, yield* Ref.get(settingsRef))
                  return Option.some<AudioSession>({
                    graph: yield* SynchronizedRef.make<AudioGraph>(AudioGraph.Registered({ audioRef }))
                  })
                }),
                Option.match({
                  onNone: () => Effect.void,
                  onSome: ({ graph }) =>
                    SynchronizedRef.get(graph).pipe(
                      Effect.flatMap((current) =>
                        AudioGraph.$is("Loaded")(current)
                          ? Effect.all([
                            Effect.sync(() => {
                              current.trackSource.disconnect()
                              current.analyserNode.disconnect()
                            }),
                            current.audioContext.state === "closed"
                              ? Effect.void
                              : Effect.promise(() => current.audioContext.close()).pipe(Effect.ignore)
                          ], { discard: true })
                          : Effect.void
                      )
                    )
                })
              )
          ),

        events: Stream.unwrap(
          Effect.gen(function*() {
            const { graph } = yield* session("observe")
            const audioRef = (yield* SynchronizedRef.get(graph)).audioRef
            return Stream.mergeAll([
              Stream.fromEventListener(audioRef, "waiting").pipe(
                Stream.map((): MediaElementEvent => MediaElementEvent.Waiting())
              ),
              Stream.fromEventListener(audioRef, "canplay").pipe(
                Stream.map((): MediaElementEvent => MediaElementEvent.CanPlay())
              ),
              Stream.fromEventListener(audioRef, "ended").pipe(
                Stream.map((): MediaElementEvent => MediaElementEvent.Ended({ currentTime: audioRef.currentTime }))
              ),
              Stream.fromEventListener(audioRef, "timeupdate").pipe(
                Stream.map((): MediaElementEvent =>
                  MediaElementEvent.TimeUpdated({ currentTime: audioRef.currentTime })
                )
              ),
              Stream.fromEventListener(audioRef, "error").pipe(
                Stream.map((): MediaElementEvent =>
                  MediaElementEvent.Failed({
                    message: audioRef.error?.message ?? "The selected audio file could not be loaded"
                  })
                )
              )
            ], { concurrency: "unbounded" })
          })
        ),

        load: (url: string) =>
          Effect.gen(function*() {
            const { graph } = yield* session("load")
            yield* SynchronizedRef.updateEffect(graph, (current) =>
              Effect.gen(function*() {
                const audioRef = current.audioRef
                const loaded = Stream.fromEventListener(audioRef, "loadeddata").pipe(
                  Stream.take(1),
                  Stream.runHead,
                  Effect.asVoid
                )
                const failed = Stream.fromEventListener(audioRef, "error").pipe(
                  Stream.take(1),
                  Stream.runHead,
                  Effect.flatMap(() =>
                    fail("load", audioRef.error?.message ?? "The selected audio file could not be loaded")
                  )
                )
                const waiting = yield* Stream.merge(loaded.pipe(Stream.fromEffect), failed.pipe(Stream.fromEffect))
                  .pipe(Stream.runHead, Effect.forkChild({ startImmediately: true }))

                yield* Effect.try({
                  try: () => {
                    audioRef.src = url
                    audioRef.load()
                  },
                  catch: () => new MediaPlayerError({ operation: "load", message: "The audio file could not load" })
                })
                yield* Fiber.join(waiting)

                if (AudioGraph.$is("Loaded")(current)) return current

                const AudioContextConstructor = window.AudioContext ??
                  (window as Window & { readonly webkitAudioContext?: typeof AudioContext }).webkitAudioContext
                if (AudioContextConstructor === undefined) {
                  return yield* fail("load", "Web Audio is not supported by this browser")
                }

                return yield* Effect.try({
                  try: () => {
                    const audioContext = new AudioContextConstructor()
                    const trackSource = audioContext.createMediaElementSource(audioRef)
                    const analyserNode = audioContext.createAnalyser()
                    analyserNode.fftSize = 256
                    trackSource.connect(analyserNode)
                    analyserNode.connect(audioContext.destination)
                    return AudioGraph.Loaded({ audioRef, audioContext, trackSource, analyserNode })
                  },
                  catch: () =>
                    new MediaPlayerError({ operation: "load", message: "The audio graph could not be connected" })
                })
              }))
          }),

        applySettings: (settings: AudioSettings) =>
          Effect.gen(function*() {
            yield* Ref.set(settingsRef, settings)
            const current = yield* ScopedRef.get(sessionRef)
            if (Option.isSome(current)) {
              yield* SynchronizedRef.get(current.value.graph).pipe(
                Effect.flatMap((graph) => applySettings(graph.audioRef, settings))
              )
            }
          }),

        play: Effect.gen(function*() {
          const { graph } = yield* session("play")
          const current = yield* SynchronizedRef.get(graph)
          if (!AudioGraph.$is("Loaded")(current)) return yield* fail("play", "The audio graph is not ready")
          yield* resume(current.audioContext, "play")
          yield* Effect.tryPromise({
            try: () => current.audioRef.play(),
            catch: () => new MediaPlayerError({ operation: "play", message: "Playback could not be started" })
          })
        }),

        pause: Effect.gen(function*() {
          const { graph } = yield* session("pause")
          const current = yield* SynchronizedRef.get(graph)
          yield* Effect.try({
            try: () => current.audioRef.pause(),
            catch: () => new MediaPlayerError({ operation: "pause", message: "Playback could not be paused" })
          })
        }),

        restart: Effect.gen(function*() {
          const { graph } = yield* session("restart")
          const current = yield* SynchronizedRef.get(graph)
          if (!AudioGraph.$is("Loaded")(current)) return yield* fail("restart", "The audio graph is not ready")
          yield* resume(current.audioContext, "restart")
          yield* Effect.tryPromise({
            try: async () => {
              current.audioRef.currentTime = 0
              await current.audioRef.play()
            },
            catch: () => new MediaPlayerError({ operation: "restart", message: "Playback could not be restarted" })
          })
        }),

        loudness: Stream.unwrap(
          Effect.gen(function*() {
            const { graph } = yield* session("analyze")
            const current = yield* SynchronizedRef.get(graph)
            if (!AudioGraph.$is("Loaded")(current)) {
              return yield* fail("analyze", "The audio analyser is not ready")
            }
            const samples = new Uint8Array(current.analyserNode.fftSize)
            return Stream.fromEffectSchedule(
              Effect.sync(() => {
                current.analyserNode.getByteTimeDomainData(samples)
                let sum = 0
                let peak = 0
                for (const value of samples) {
                  const normalized = (value - 128) / 128
                  sum += normalized * normalized
                  peak = Math.max(peak, Math.abs(normalized))
                }
                const rms = Math.sqrt(sum / samples.length)
                return { rms, peak, decibels: 20 * Math.log10(Math.max(rms, 0.0001)) } satisfies LoudnessSample
              }),
              Schedule.spaced("100 millis")
            )
          })
        ),

        reportError: (message: string) => Effect.logError(message)
      }
    })
  }
) {
  static readonly layer = Layer.effect(this)(this.make)
}
