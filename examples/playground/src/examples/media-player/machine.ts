import { Machine } from "@typeonce/effect-machine"
import { Effect } from "effect"
import { analyzeAudio, applyAudioSettings, loadAudio, pauseAudio, playAudio, restartAudio } from "./invocations.ts"
import {
  initialAudioSettings,
  initialPlaybackData,
  MediaPlayerEvent,
  MediaPlayerInternalEvent,
  MediaPlayerState,
  MediaPlayerStates,
  updatePlaybackData
} from "./schemas.ts"
import { MediaPlayer } from "./service.ts"

const initialPlayer = () =>
  MediaPlayerStates.initial.Player(MediaPlayerState.cases.Player.make({}), (player) =>
    player
      .transport(
        MediaPlayerState.cases.Transport.make({}),
        (transport) => transport.Empty(MediaPlayerState.cases.Empty.make({}))
      )
      .settings(
        MediaPlayerState.cases.Settings.make({}),
        (settings) =>
          settings.Audible(MediaPlayerState.cases.Audible.make({
            volume: initialAudioSettings.volume,
            playbackRate: initialAudioSettings.playbackRate
          }))
      ))

export const MediaPlayerMachine = Machine.make({
  id: "MediaPlayer",
  states: MediaPlayerStates.states,
  events: [MediaPlayerEvent],
  internalEvents: [MediaPlayerInternalEvent],
  initial: initialPlayer
}).handle({
  Player: {
    states: {
      transport: {
        on: {
          SourceSelected: {
            reenter: true,
            transition: ({ event, target }) =>
              target.local.Loading(MediaPlayerState.cases.Loading.make({ url: event.url }))
          },

          MediaFailed: ({ event, target }) =>
            target.local.Failed(MediaPlayerState.cases.Failed.make({ message: event.message })),

          OperationFailed: ({ event, target }) =>
            target.local.Failed(MediaPlayerState.cases.Failed.make({ message: event.message }))
        },
        states: {
          Empty: {},

          Loading: {
            invoke: ({ state }) => loadAudio(state.url),
            on: {
              LoadSucceeded: ({ target }) =>
                target.local.Ready(
                  MediaPlayerState.cases.Ready.make({}),
                  (ready) => ready.Paused(MediaPlayerState.cases.Paused.make(initialPlaybackData))
                )
            }
          },

          Ready: {
            states: {
              Paused: {
                invoke: pauseAudio,
                on: {
                  PlayRequested: ({ state, target }) =>
                    target.local.Playing(
                      MediaPlayerState.cases.Playing.make({
                        ...updatePlaybackData(state, {}),
                        loudness: null
                      })
                    ),

                  RestartRequested: ({ state, target }) =>
                    target.local.Restarting(
                      MediaPlayerState.cases.Restarting.make(updatePlaybackData(state, {}))
                    )
                }
              },

              Playing: {
                invoke: [playAudio, analyzeAudio],
                on: {
                  PauseRequested: ({ state, target }) =>
                    target.local.Paused(
                      MediaPlayerState.cases.Paused.make(updatePlaybackData(state, {}))
                    ),

                  RestartRequested: ({ state, target }) =>
                    target.local.Restarting(
                      MediaPlayerState.cases.Restarting.make(updatePlaybackData(state, {}))
                    ),

                  MediaWaiting: ({ state, target }) =>
                    target.local.Buffering(
                      MediaPlayerState.cases.Buffering.make(updatePlaybackData(state, {}))
                    ),

                  PlaybackEnded: ({ event, state, target }) =>
                    target.local.Ended(
                      MediaPlayerState.cases.Ended.make(
                        updatePlaybackData(state, { currentTime: event.currentTime })
                      )
                    ),

                  TimeUpdated: ({ event, state, target }) =>
                    target.local.Playing(
                      MediaPlayerState.cases.Playing.make({
                        currentTime: event.currentTime,
                        loudness: state.loudness
                      })
                    ),

                  LoudnessMeasured: ({ event, state, target }) =>
                    target.local.Playing(
                      MediaPlayerState.cases.Playing.make({
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
                  MediaCanPlay: ({ state, target }) =>
                    target.local.Playing(
                      MediaPlayerState.cases.Playing.make({
                        ...updatePlaybackData(state, {}),
                        loudness: null
                      })
                    ),

                  PauseRequested: ({ state, target }) =>
                    target.local.Paused(
                      MediaPlayerState.cases.Paused.make(updatePlaybackData(state, {}))
                    ),

                  RestartRequested: ({ state, target }) =>
                    target.local.Restarting(
                      MediaPlayerState.cases.Restarting.make(updatePlaybackData(state, {}))
                    ),

                  PlaybackEnded: ({ event, state, target }) =>
                    target.local.Ended(
                      MediaPlayerState.cases.Ended.make(
                        updatePlaybackData(state, { currentTime: event.currentTime })
                      )
                    ),

                  TimeUpdated: ({ event, state, target }) =>
                    target.local.Buffering(
                      MediaPlayerState.cases.Buffering.make(
                        updatePlaybackData(state, { currentTime: event.currentTime })
                      )
                    )
                }
              },

              Restarting: {
                invoke: restartAudio,
                on: {
                  RestartSucceeded: ({ target }) =>
                    target.local.Playing(
                      MediaPlayerState.cases.Playing.make({ currentTime: 0, loudness: null })
                    ),

                  TimeUpdated: ({ event, state, target }) =>
                    target.local.Restarting(
                      MediaPlayerState.cases.Restarting.make(
                        updatePlaybackData(state, { currentTime: event.currentTime })
                      )
                    )
                }
              },

              Ended: {
                on: {
                  PlayRequested: ({ state, target }) =>
                    target.local.Restarting(
                      MediaPlayerState.cases.Restarting.make(updatePlaybackData(state, {}))
                    ),

                  RestartRequested: ({ state, target }) =>
                    target.local.Restarting(
                      MediaPlayerState.cases.Restarting.make(updatePlaybackData(state, {}))
                    )
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
                  target.local.Audible(MediaPlayerState.cases.Audible.make({
                    volume: event.volume,
                    playbackRate: state.playbackRate
                  }))
              },

              PlaybackRateChanged: {
                reenter: true,
                transition: ({ event, state, target }) =>
                  target.local.Audible(MediaPlayerState.cases.Audible.make({
                    volume: state.volume,
                    playbackRate: event.playbackRate
                  }))
              },

              MuteRequested: ({ state, target }) =>
                target.local.Muted(MediaPlayerState.cases.Muted.make({
                  volume: state.volume,
                  playbackRate: state.playbackRate
                }))
            }
          },

          Muted: {
            invoke: ({ state }) => applyAudioSettings(state, true),
            on: {
              VolumeChanged: {
                reenter: true,
                transition: ({ event, state, target }) =>
                  target.local.Muted(MediaPlayerState.cases.Muted.make({
                    volume: event.volume,
                    playbackRate: state.playbackRate
                  }))
              },

              PlaybackRateChanged: {
                reenter: true,
                transition: ({ event, state, target }) =>
                  target.local.Muted(MediaPlayerState.cases.Muted.make({
                    volume: state.volume,
                    playbackRate: event.playbackRate
                  }))
              },

              UnmuteRequested: ({ state, target }) =>
                target.local.Audible(MediaPlayerState.cases.Audible.make({
                  volume: state.volume,
                  playbackRate: state.playbackRate
                }))
            }
          }
        }
      }
    }
  }
})
