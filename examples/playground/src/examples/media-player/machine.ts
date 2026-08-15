import { Machine } from "@typeonce/effect-machine"
import { Effect } from "effect"
import { MediaPlayerDefinition, MediaPlayerInternalEvents } from "./definition.ts"
import {
  analyzeAudio,
  applyAudioSettings,
  loadAudio,
  loudnessEvent,
  pauseAudio,
  playAudio,
  restartAudio
} from "./invocations.ts"
import { initialPlaybackData, updatePlaybackData } from "./schemas.ts"
import { MediaPlayer } from "./service.ts"

export const MediaPlayerMachine = MediaPlayerDefinition.handle({
  Player: {
    states: {
      transport: {
        on: {
          SourceSelected: {
            reenter: true,
            transition: ({ event, target }) => target.local.Loading.from({ url: event.url })
          },

          MediaFailed: ({ event, target }) => target.local.Failed.from({ message: event.message }),

          OperationFailed: ({ event, target }) => target.local.Failed.from({ message: event.message })
        },
        states: {
          Empty: {},

          Loading: {
            invoke: Machine.invoke({
              id: "load-audio",
              effect: ({ state }) => loadAudio(state.url),
              onDone: ({ target }, enqueue) => {
                enqueue.raise(MediaPlayerInternalEvents.LoadSucceeded())
                return target.none()
              },
              onFailure: ({ error, target }, enqueue) => {
                enqueue.raise(MediaPlayerInternalEvents.OperationFailed({ message: error.message }))
                return target.none()
              }
            }),
            on: {
              LoadSucceeded: ({ target }) => target.local.Ready.from((ready) => ready.Paused.from(initialPlaybackData))
            }
          },

          Ready: {
            states: {
              Paused: {
                invoke: Machine.invoke({
                  id: "pause-audio",
                  effect: pauseAudio,
                  onDone: ({ target }) => target.none(),
                  onFailure: ({ error, target }, enqueue) => {
                    enqueue.raise(MediaPlayerInternalEvents.OperationFailed({ message: error.message }))
                    return target.none()
                  }
                }),
                on: {
                  PlayRequested: ({ state, target }) =>
                    target.local.Playing.from({
                      ...updatePlaybackData(state, {}),
                      loudness: null
                    }),

                  RestartRequested: ({ state, target }) => target.local.Restarting.from(updatePlaybackData(state, {}))
                }
              },

              Playing: {
                invoke: [
                  Machine.invoke({
                    id: "play-audio",
                    effect: playAudio,
                    onDone: ({ target }) => target.none(),
                    onFailure: ({ error, target }, enqueue) => {
                      enqueue.raise(MediaPlayerInternalEvents.OperationFailed({ message: error.message }))
                      return target.none()
                    }
                  }),
                  Machine.invoke({
                    id: "analyze-audio",
                    address: Machine.childAddress("analyze-audio"),
                    logic: analyzeAudio,
                    onDone: ({ target }) => target.none(),
                    onSnapshot: ({ snapshot, target }, enqueue) => {
                      const event = loudnessEvent(snapshot.state)
                      if (event !== undefined) enqueue.raise(event)
                      return target.none()
                    }
                  })
                ],
                on: {
                  PauseRequested: ({ state, target }) => target.local.Paused.from(updatePlaybackData(state, {})),

                  RestartRequested: ({ state, target }) => target.local.Restarting.from(updatePlaybackData(state, {})),

                  MediaWaiting: ({ state, target }) => target.local.Buffering.from(updatePlaybackData(state, {})),

                  PlaybackEnded: ({ event, state, target }) =>
                    target.local.Ended.from(updatePlaybackData(state, { currentTime: event.currentTime })),

                  TimeUpdated: ({ event, state, target }) =>
                    target.local.Playing.from({
                      currentTime: event.currentTime,
                      loudness: state.loudness
                    }),

                  LoudnessMeasured: ({ event, state, target }) =>
                    target.local.Playing.from({
                      currentTime: state.currentTime,
                      loudness: {
                        rms: event.rms,
                        peak: event.peak,
                        decibels: event.decibels
                      }
                    })
                }
              },

              Buffering: {
                on: {
                  MediaCanPlay: ({ state, target }) =>
                    target.local.Playing.from({
                      ...updatePlaybackData(state, {}),
                      loudness: null
                    }),

                  PauseRequested: ({ state, target }) => target.local.Paused.from(updatePlaybackData(state, {})),

                  RestartRequested: ({ state, target }) => target.local.Restarting.from(updatePlaybackData(state, {})),

                  PlaybackEnded: ({ event, state, target }) =>
                    target.local.Ended.from(updatePlaybackData(state, { currentTime: event.currentTime })),

                  TimeUpdated: ({ event, state, target }) =>
                    target.local.Buffering.from(updatePlaybackData(state, { currentTime: event.currentTime }))
                }
              },

              Restarting: {
                invoke: Machine.invoke({
                  id: "restart-audio",
                  effect: restartAudio,
                  onDone: ({ target }, enqueue) => {
                    enqueue.raise(MediaPlayerInternalEvents.RestartSucceeded())
                    return target.none()
                  },
                  onFailure: ({ error, target }, enqueue) => {
                    enqueue.raise(MediaPlayerInternalEvents.OperationFailed({ message: error.message }))
                    return target.none()
                  }
                }),
                on: {
                  RestartSucceeded: ({ target }) => target.local.Playing.from({ currentTime: 0, loudness: null }),

                  TimeUpdated: ({ event, state, target }) =>
                    target.local.Restarting.from(updatePlaybackData(state, { currentTime: event.currentTime }))
                }
              },

              Ended: {
                on: {
                  PlayRequested: ({ state, target }) => target.local.Restarting.from(updatePlaybackData(state, {})),

                  RestartRequested: ({ state, target }) => target.local.Restarting.from(updatePlaybackData(state, {}))
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
              onDone: ({ target }) => target.none()
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
              onDone: ({ target }) => target.none()
            }),
            on: {
              VolumeChanged: {
                reenter: true,
                transition: ({ event, state, target }) =>
                  target.local.Audible.from({
                    volume: event.volume,
                    playbackRate: state.playbackRate
                  })
              },

              PlaybackRateChanged: {
                reenter: true,
                transition: ({ event, state, target }) =>
                  target.local.Audible.from({
                    volume: state.volume,
                    playbackRate: event.playbackRate
                  })
              },

              MuteRequested: ({ state, target }) =>
                target.local.Muted.from({
                  volume: state.volume,
                  playbackRate: state.playbackRate
                })
            }
          },

          Muted: {
            invoke: Machine.invoke({
              id: "apply-audio-settings",
              effect: ({ state }) => applyAudioSettings(state, true),
              onDone: ({ target }) => target.none()
            }),
            on: {
              VolumeChanged: {
                reenter: true,
                transition: ({ event, state, target }) =>
                  target.local.Muted.from({
                    volume: event.volume,
                    playbackRate: state.playbackRate
                  })
              },

              PlaybackRateChanged: {
                reenter: true,
                transition: ({ event, state, target }) =>
                  target.local.Muted.from({
                    volume: state.volume,
                    playbackRate: event.playbackRate
                  })
              },

              UnmuteRequested: ({ state, target }) =>
                target.local.Audible.from({
                  volume: state.volume,
                  playbackRate: state.playbackRate
                })
            }
          }
        }
      }
    }
  }
})
