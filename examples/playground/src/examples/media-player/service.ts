import { Context, Data, Effect, Layer, Schedule, Stream, SynchronizedRef } from "effect"
import { type AudioSettings, initialAudioSettings, type LoudnessSample } from "./schemas.ts"

export class MediaPlayerError extends Data.TaggedError("MediaPlayerError")<{
  readonly operation: "load" | "play" | "pause" | "restart" | "analyze"
  readonly message: string
}> {}

type MediaGraph = Data.TaggedEnum<{
  Empty: {
    readonly settings: AudioSettings
  }
  Registered: {
    readonly audioRef: HTMLAudioElement
    readonly audioContext: AudioContext | null
    readonly settings: AudioSettings
  }
  Loaded: {
    readonly audioRef: HTMLAudioElement
    readonly audioContext: AudioContext
    readonly trackSource: MediaElementAudioSourceNode
    readonly analyserNode: AnalyserNode
    readonly settings: AudioSettings
  }
}>

const MediaGraph = Data.taggedEnum<MediaGraph>()

type BrowserWindow = Window & {
  readonly webkitAudioContext?: typeof AudioContext
}

const error = (
  operation: MediaPlayerError["operation"],
  message: string
): MediaPlayerError => new MediaPlayerError({ operation, message })

const applySettingsToElement = (
  audioRef: HTMLAudioElement,
  settings: AudioSettings
): void => {
  audioRef.volume = settings.volume
  audioRef.muted = settings.muted
  audioRef.playbackRate = settings.playbackRate
}

const waitForMedia = (
  audioRef: HTMLAudioElement,
  url: string
): Effect.Effect<void, MediaPlayerError> =>
  Effect.callback<void, MediaPlayerError>((resume) => {
    const cleanup = () => {
      audioRef.removeEventListener("loadeddata", onLoaded)
      audioRef.removeEventListener("error", onError)
    }
    const onLoaded = () => {
      cleanup()
      resume(Effect.void)
    }
    const onError = () => {
      cleanup()
      resume(Effect.fail(error("load", audioRef.error?.message ?? "The selected audio file could not be loaded")))
    }

    audioRef.addEventListener("loadeddata", onLoaded, { once: true })
    audioRef.addEventListener("error", onError, { once: true })

    try {
      audioRef.src = url
      audioRef.load()
    } catch {
      onError()
    }

    return Effect.sync(cleanup)
  })

const releaseGraph = (graphRef: SynchronizedRef.SynchronizedRef<MediaGraph>) =>
  SynchronizedRef.updateEffect(graphRef, (graph) =>
    Effect.gen(function*() {
      if (graph._tag === "Loaded") {
        yield* Effect.sync(() => {
          graph.trackSource.disconnect()
          graph.analyserNode.disconnect()
        })
      }

      const audioContext = graph._tag === "Empty" ? null : graph.audioContext

      if (audioContext !== null && audioContext.state !== "closed") {
        yield* Effect.tryPromise({
          try: () => audioContext.close(),
          catch: () => undefined
        }).pipe(Effect.ignore)
      }

      return MediaGraph.Empty({ settings: graph.settings })
    }))

export class MediaPlayer extends Context.Service<MediaPlayer>()(
  "effect-machine/playground/MediaPlayer",
  {
    make: Effect.acquireRelease(
      Effect.gen(function*() {
        const graphRef = yield* SynchronizedRef.make<MediaGraph>(
          MediaGraph.Empty({ settings: initialAudioSettings })
        )

        const service = {
          register: (nextAudioRef: HTMLAudioElement) =>
            SynchronizedRef.updateEffect(graphRef, (graph) => {
              if (graph._tag !== "Empty" && graph.audioRef === nextAudioRef) {
                return Effect.sync(() => {
                  applySettingsToElement(nextAudioRef, graph.settings)
                  return graph
                })
              }

              return Effect.sync(() => {
                if (graph._tag === "Loaded") {
                  graph.trackSource.disconnect()
                  graph.analyserNode.disconnect()
                }

                applySettingsToElement(nextAudioRef, graph.settings)

                return MediaGraph.Registered({
                  audioRef: nextAudioRef,
                  audioContext: graph._tag === "Empty" ? null : graph.audioContext,
                  settings: graph.settings
                })
              })
            }),

          load: (url: string) =>
            SynchronizedRef.updateEffect(
              graphRef,
              (graph): Effect.Effect<MediaGraph, MediaPlayerError> =>
                Effect.gen(function*() {
                  if (graph._tag === "Empty") {
                    return yield* Effect.fail(error("load", "The audio element is not ready"))
                  }

                  yield* waitForMedia(graph.audioRef, url)

                  if (graph._tag === "Loaded") return graph

                  const AudioContextConstructor = window.AudioContext ?? (window as BrowserWindow).webkitAudioContext

                  if (AudioContextConstructor === undefined) {
                    return yield* Effect.fail(error("load", "Web Audio is not supported by this browser"))
                  }

                  return yield* Effect.try({
                    try: () => {
                      const audioContext = graph.audioContext === null || graph.audioContext.state === "closed"
                        ? new AudioContextConstructor()
                        : graph.audioContext
                      const trackSource = audioContext.createMediaElementSource(graph.audioRef)
                      const analyserNode = audioContext.createAnalyser()

                      analyserNode.fftSize = 256
                      trackSource.connect(analyserNode)
                      analyserNode.connect(audioContext.destination)

                      return MediaGraph.Loaded({
                        audioRef: graph.audioRef,
                        audioContext,
                        trackSource,
                        analyserNode,
                        settings: graph.settings
                      })
                    },
                    catch: () => error("load", "The audio graph could not be connected")
                  })
                })
            ),

          applySettings: (settings: AudioSettings) =>
            SynchronizedRef.updateEffect(graphRef, (graph) =>
              Effect.sync(() => {
                if (graph._tag !== "Empty") {
                  applySettingsToElement(graph.audioRef, settings)
                }

                return MediaGraph.$match(graph, {
                  Empty: () => MediaGraph.Empty({ settings }),
                  Registered: ({ audioRef, audioContext }) =>
                    MediaGraph.Registered({ audioRef, audioContext, settings }),
                  Loaded: ({ audioRef, audioContext, trackSource, analyserNode }) =>
                    MediaGraph.Loaded({ audioRef, audioContext, trackSource, analyserNode, settings })
                })
              })),

          play: SynchronizedRef.updateEffect(
            graphRef,
            (graph): Effect.Effect<MediaGraph, MediaPlayerError> =>
              Effect.gen(function*() {
                if (graph._tag !== "Loaded") {
                  return yield* Effect.fail(error("play", "The audio graph is not ready"))
                }

                if (graph.audioContext.state === "suspended") {
                  yield* Effect.tryPromise({
                    try: () => graph.audioContext.resume(),
                    catch: () => error("play", "The audio context could not be resumed")
                  })
                }

                yield* Effect.tryPromise({
                  try: () => graph.audioRef.play(),
                  catch: () => error("play", "Playback could not be started")
                })

                return graph
              })
          ),

          pause: SynchronizedRef.updateEffect(
            graphRef,
            (graph): Effect.Effect<MediaGraph, MediaPlayerError> =>
              Effect.gen(function*() {
                if (graph._tag === "Empty") {
                  return yield* Effect.fail(error("pause", "The audio element is not ready"))
                }

                yield* Effect.try({
                  try: () => graph.audioRef.pause(),
                  catch: () => error("pause", "Playback could not be paused")
                })

                return graph
              })
          ),

          restart: SynchronizedRef.updateEffect(
            graphRef,
            (graph): Effect.Effect<MediaGraph, MediaPlayerError> =>
              Effect.gen(function*() {
                if (graph._tag !== "Loaded") {
                  return yield* Effect.fail(error("restart", "The audio graph is not ready"))
                }

                if (graph.audioContext.state === "suspended") {
                  yield* Effect.tryPromise({
                    try: () => graph.audioContext.resume(),
                    catch: () => error("restart", "The audio context could not be resumed")
                  })
                }

                yield* Effect.tryPromise({
                  try: async () => {
                    graph.audioRef.currentTime = 0
                    await graph.audioRef.play()
                  },
                  catch: () => error("restart", "Playback could not be restarted")
                })

                return graph
              })
          ),

          loudness: Stream.unwrap(
            Effect.gen(function*() {
              const graph = yield* SynchronizedRef.get(graphRef)

              if (graph._tag !== "Loaded") {
                return yield* Effect.fail(error("analyze", "The audio analyser is not ready"))
              }

              const samples = new Uint8Array(graph.analyserNode.fftSize)

              return Stream.fromEffectSchedule(
                Effect.sync(() => {
                  graph.analyserNode.getByteTimeDomainData(samples)

                  let sum = 0
                  let peak = 0

                  for (const value of samples) {
                    const normalized = (value - 128) / 128
                    const absolute = Math.abs(normalized)

                    sum += normalized * normalized
                    peak = Math.max(peak, absolute)
                  }

                  const rms = Math.sqrt(sum / samples.length)

                  return {
                    rms,
                    peak,
                    decibels: 20 * Math.log10(Math.max(rms, 0.0001))
                  } satisfies LoudnessSample
                }),
                Schedule.spaced("100 millis")
              )
            })
          ),

          reportError: (message: string) =>
            Effect.sync(() => {
              console.error(`[media-player] ${message}`)
            })
        }

        return { graphRef, service }
      }),
      ({ graphRef }) => releaseGraph(graphRef)
    ).pipe(Effect.map(({ service }) => service))
  }
) {
  static readonly layer = Layer.effect(this)(this.make)
}
