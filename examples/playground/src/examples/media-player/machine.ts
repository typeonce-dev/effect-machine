import { Machine } from "@typeonce/effect-machine"
import { Effect } from "effect"
import { MediaPlayerDefinition } from "./definition.ts"
import { analyzeAudio, applyAudioSettings, loadAudio, pauseAudio, playAudio, restartAudio } from "./invocations.ts"
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
            invoke: ({ state }) => loadAudio(state.url),
            on: {
              LoadSucceeded: ({ target }) => target.local.Ready.from((ready) => ready.Paused.from(initialPlaybackData))
            }
          },

          Ready: {
            states: {
              Paused: {
                invoke: pauseAudio,
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
                invoke: [playAudio, analyzeAudio],
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
                invoke: restartAudio,
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
            invoke: ({ state }) =>
              Machine.invoke({
                id: "report-error",
                src: () =>
                  Machine.effect(
                    Effect.gen(function*() {
                      const mediaPlayer = yield* MediaPlayer
                      yield* mediaPlayer.reportError(state.message)
                    })
                  )
              })
          }
        }
      },

      settings: {
        states: {
          Audible: {
            invoke: ({ state }) => applyAudioSettings(state, false),
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
            invoke: ({ state }) => applyAudioSettings(state, true),
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
