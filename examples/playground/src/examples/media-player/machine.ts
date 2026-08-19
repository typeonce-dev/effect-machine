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
            invoke: (from) =>
              from.effect("load-audio", ({ state }) => loadAudio(state.url)).onDone((to) =>
                to.none.resolve((_, enqueue) => {
                  enqueue.raise(MediaPlayerInternalEvents.LoadSucceeded())
                  return undefined
                })
              ).onFailure((to) =>
                to.none.resolve(({ error }, enqueue) => {
                  enqueue.raise(MediaPlayerInternalEvents.OperationFailed({ message: error.message }))
                  return undefined
                })
              ),
            on: {
              LoadSucceeded: (to) =>
                to.local.Ready().resolve(({ target }) => target.from((ready) => ready.Paused.from(initialPlaybackData)))
            }
          },

          Ready: {
            states: {
              Paused: {
                invoke: (from) =>
                  from.effect("pause-audio", () => pauseAudio).onDone((to) => to.none).onFailure((to) =>
                    to.none.resolve(({ error }, enqueue) => {
                      enqueue.raise(MediaPlayerInternalEvents.OperationFailed({ message: error.message }))
                      return undefined
                    })
                  ),
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
                invoke: (
                  from
                ) => [
                  from.effect("play-audio", () => playAudio).onDone((to) => to.none).onFailure((to) =>
                    to.none.resolve(({ error }, enqueue) => {
                      enqueue.raise(MediaPlayerInternalEvents.OperationFailed({ message: error.message }))
                      return undefined
                    })
                  ),
                  from.stream("analyze-audio", () => analyzeAudio).onElement((to) =>
                    to.none.resolve(({ element }, enqueue) => {
                      enqueue.raise(MediaPlayerInternalEvents.LoudnessMeasured(element))
                    })
                  ).onDone((to) => to.none).onFailure((to) =>
                    to.none.resolve(({ error }, enqueue) => {
                      enqueue.raise(MediaPlayerInternalEvents.OperationFailed({ message: error.message }))
                    })
                  )
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
                invoke: (from) =>
                  from.effect("restart-audio", () => restartAudio).onDone((to) =>
                    to.none.resolve((_, enqueue) => {
                      enqueue.raise(MediaPlayerInternalEvents.RestartSucceeded())
                      return undefined
                    })
                  ).onFailure((to) =>
                    to.none.resolve(({ error }, enqueue) => {
                      enqueue.raise(MediaPlayerInternalEvents.OperationFailed({ message: error.message }))
                      return undefined
                    })
                  ),
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
            invoke: (from) =>
              from.effect("report-error", ({ state }) =>
                Effect.gen(function*() {
                  const mediaPlayer = yield* MediaPlayer
                  yield* mediaPlayer.reportError(state.message)
                })).onDone((to) => to.none)
          }
        }
      },

      settings: {
        states: {
          Audible: {
            invoke: (from) =>
              from.effect("apply-audio-settings", ({ state }) => applyAudioSettings(state, false)).onDone((to) =>
                to.none
              ),
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
            invoke: (from) =>
              from.effect("apply-audio-settings", ({ state }) => applyAudioSettings(state, true)).onDone((to) =>
                to.none
              ),
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
