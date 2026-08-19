import { Machine } from "@typeonce/effect-machine"
import { Effect } from "effect"
import { MediaPlayerDefinition, MediaPlayerInternalEvents } from "./definition.ts"
import { analyzeAudio, applyAudioSettings, loadAudio, pauseAudio, playAudio, restartAudio } from "./invocations.ts"
import { initialPlaybackData, updatePlaybackData } from "./schemas.ts"
import { MediaPlayer } from "./service.ts"

export const MediaPlayerMachine = MediaPlayerDefinition.handle({
  Player: {
    states: {
      transport: {
        on: {
          SourceSelected: (to) =>
            to.local.Loading().resolve(({ event, target }) => target.from({ url: event.url }), { reenter: true }),

          MediaFailed: (to) =>
            to.local.Failed().resolve(({ event, target }) => target.from({ message: event.message })),

          OperationFailed: (to) =>
            to.local.Failed().resolve(({ event, target }) => target.from({ message: event.message }))
        },
        states: {
          Empty: {},

          Loading: {
            invoke: Machine.invoke({
              id: "load-audio",
              effect: ({ state }) => loadAudio(state.url),
              onDone: (to) =>
                to.none.resolve((_, enqueue) => {
                  enqueue.raise(MediaPlayerInternalEvents.LoadSucceeded())
                  return undefined
                }),
              onFailure: (to) =>
                to.none.resolve(({ error }, enqueue) => {
                  enqueue.raise(MediaPlayerInternalEvents.OperationFailed({ message: error.message }))
                  return undefined
                })
            }),
            on: {
              LoadSucceeded: (to) =>
                to.local.Ready().resolve(({ target }) => target.from((ready) => ready.Paused.from(initialPlaybackData)))
            }
          },

          Ready: {
            states: {
              Paused: {
                invoke: Machine.invoke({
                  id: "pause-audio",
                  effect: () => pauseAudio,
                  onDone: (to) => to.none,
                  onFailure: (to) =>
                    to.none.resolve(({ error }, enqueue) => {
                      enqueue.raise(MediaPlayerInternalEvents.OperationFailed({ message: error.message }))
                      return undefined
                    })
                }),
                on: {
                  PlayRequested: (to) =>
                    to.local.Playing().resolve(({ state, target }) =>
                      target.from({
                        ...updatePlaybackData(state, {}),
                        loudness: null
                      })
                    ),

                  RestartRequested: (to) =>
                    to.local.Restarting().resolve(({ state, target }) => target.from(updatePlaybackData(state, {})))
                }
              },

              Playing: {
                invoke: [
                  Machine.invoke({
                    id: "play-audio",
                    effect: () => playAudio,
                    onDone: (to) => to.none,
                    onFailure: (to) =>
                      to.none.resolve(({ error }, enqueue) => {
                        enqueue.raise(MediaPlayerInternalEvents.OperationFailed({ message: error.message }))
                        return undefined
                      })
                  }),
                  Machine.invoke({
                    id: "analyze-audio",
                    stream: () => analyzeAudio,
                    onElement: (to) =>
                      to.none.resolve(({ element }, enqueue) => {
                        enqueue.raise(MediaPlayerInternalEvents.LoudnessMeasured(element))
                      }),
                    onDone: (to) => to.none,
                    onFailure: (to) =>
                      to.none.resolve(({ error }, enqueue) => {
                        enqueue.raise(MediaPlayerInternalEvents.OperationFailed({ message: error.message }))
                      })
                  })
                ],
                on: {
                  PauseRequested: (to) =>
                    to.local.Paused().resolve(({ state, target }) => target.from(updatePlaybackData(state, {}))),

                  RestartRequested: (to) =>
                    to.local.Restarting().resolve(({ state, target }) => target.from(updatePlaybackData(state, {}))),

                  MediaWaiting: (to) =>
                    to.local.Buffering().resolve(({ state, target }) => target.from(updatePlaybackData(state, {}))),

                  PlaybackEnded: (to) =>
                    to.local.Ended().resolve(({ event, state, target }) =>
                      target.from(updatePlaybackData(state, { currentTime: event.currentTime }))
                    ),

                  TimeUpdated: (to) =>
                    to.local.Playing().resolve(({ event, state, target }) =>
                      target.from({
                        currentTime: event.currentTime,
                        loudness: state.loudness
                      })
                    ),

                  LoudnessMeasured: (to) =>
                    to.local.Playing().resolve(({ event, state, target }) =>
                      target.from({
                        currentTime: state.currentTime,
                        loudness: {
                          rms: event.rms,
                          peak: event.peak,
                          decibels: event.decibels
                        }
                      })
                    )
                }
              },

              Buffering: {
                on: {
                  MediaCanPlay: (to) =>
                    to.local.Playing().resolve(({ state, target }) =>
                      target.from({
                        ...updatePlaybackData(state, {}),
                        loudness: null
                      })
                    ),

                  PauseRequested: (to) =>
                    to.local.Paused().resolve(({ state, target }) => target.from(updatePlaybackData(state, {}))),

                  RestartRequested: (to) =>
                    to.local.Restarting().resolve(({ state, target }) => target.from(updatePlaybackData(state, {}))),

                  PlaybackEnded: (to) =>
                    to.local.Ended().resolve(({ event, state, target }) =>
                      target.from(updatePlaybackData(state, { currentTime: event.currentTime }))
                    ),

                  TimeUpdated: (to) =>
                    to.local.Buffering().resolve(({ event, state, target }) =>
                      target.from(updatePlaybackData(state, { currentTime: event.currentTime }))
                    )
                }
              },

              Restarting: {
                invoke: Machine.invoke({
                  id: "restart-audio",
                  effect: () => restartAudio,
                  onDone: (to) =>
                    to.none.resolve((_, enqueue) => {
                      enqueue.raise(MediaPlayerInternalEvents.RestartSucceeded())
                      return undefined
                    }),
                  onFailure: (to) =>
                    to.none.resolve(({ error }, enqueue) => {
                      enqueue.raise(MediaPlayerInternalEvents.OperationFailed({ message: error.message }))
                      return undefined
                    })
                }),
                on: {
                  RestartSucceeded: (to) =>
                    to.local.Playing().resolve(({ target }) => target.from({ currentTime: 0, loudness: null })),

                  TimeUpdated: (to) =>
                    to.local.Restarting().resolve(({ event, state, target }) =>
                      target.from(updatePlaybackData(state, { currentTime: event.currentTime }))
                    )
                }
              },

              Ended: {
                on: {
                  PlayRequested: (to) =>
                    to.local.Restarting().resolve(({ state, target }) => target.from(updatePlaybackData(state, {}))),

                  RestartRequested: (to) =>
                    to.local.Restarting().resolve(({ state, target }) => target.from(updatePlaybackData(state, {})))
                }
              }
            }
          },

          Failed: {
            invoke: Machine.invoke({
              id: "report-error",
              effect: ({ state }) =>
                Effect.gen(function*() {
                  const mediaPlayer = yield* MediaPlayer
                  yield* mediaPlayer.reportError(state.message)
                }),
              onDone: (to) => to.none
            })
          }
        }
      },

      settings: {
        states: {
          Audible: {
            invoke: Machine.invoke({
              id: "apply-audio-settings",
              effect: ({ state }) => applyAudioSettings(state, false),
              onDone: (to) => to.none
            }),
            on: {
              VolumeChanged: (to) =>
                to.local.Audible().resolve(({ event, state, target }) =>
                  target.from({
                    volume: event.volume,
                    playbackRate: state.playbackRate
                  }), { reenter: true }),

              PlaybackRateChanged: (to) =>
                to.local.Audible().resolve(({ event, state, target }) =>
                  target.from({
                    volume: state.volume,
                    playbackRate: event.playbackRate
                  }), { reenter: true }),

              MuteRequested: (to) =>
                to.local.Muted().resolve(({ state, target }) =>
                  target.from({
                    volume: state.volume,
                    playbackRate: state.playbackRate
                  })
                )
            }
          },

          Muted: {
            invoke: Machine.invoke({
              id: "apply-audio-settings",
              effect: ({ state }) => applyAudioSettings(state, true),
              onDone: (to) => to.none
            }),
            on: {
              VolumeChanged: (to) =>
                to.local.Muted().resolve(({ event, state, target }) =>
                  target.from({
                    volume: event.volume,
                    playbackRate: state.playbackRate
                  }), { reenter: true }),

              PlaybackRateChanged: (to) =>
                to.local.Muted().resolve(({ event, state, target }) =>
                  target.from({
                    volume: state.volume,
                    playbackRate: event.playbackRate
                  }), { reenter: true }),

              UnmuteRequested: (to) =>
                to.local.Audible().resolve(({ state, target }) =>
                  target.from({
                    volume: state.volume,
                    playbackRate: state.playbackRate
                  })
                )
            }
          }
        }
      }
    }
  }
})
