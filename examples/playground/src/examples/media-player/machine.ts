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
          SourceSelected: Machine.transition({
            target: (to) => to.local.Loading(),
            resolve: ({ event, target }) => target.from({ url: event.url }),
            reenter: true
          }),

          MediaFailed: Machine.transition({
            target: (to) => to.local.Failed(),
            resolve: ({ event, target }) => target.from({ message: event.message })
          }),

          OperationFailed: Machine.transition({
            target: (to) => to.local.Failed(),
            resolve: ({ event, target }) => target.from({ message: event.message })
          })
        },
        states: {
          Empty: {},

          Loading: {
            invoke: MediaPlayerDefinition.invoke({
              id: "load-audio",
              effect: ({ state }) => loadAudio(state.url),
              onDone: Machine.transition({
                target: (to) => to.none(),
                resolve: (_, enqueue) => {
                  enqueue.raise(MediaPlayerInternalEvents.LoadSucceeded())
                  return undefined
                }
              }),
              onFailure: Machine.transition({
                target: (to) => to.none(),
                resolve: ({ error }, enqueue) => {
                  enqueue.raise(MediaPlayerInternalEvents.OperationFailed({ message: error.message }))
                  return undefined
                }
              })
            }),
            on: {
              LoadSucceeded: Machine.transition({
                target: (to) => to.local.Ready(),
                resolve: ({ target }) => target.from((ready) => ready.Paused.from(initialPlaybackData))
              })
            }
          },

          Ready: {
            states: {
              Paused: {
                invoke: MediaPlayerDefinition.invoke({
                  id: "pause-audio",
                  effect: () => pauseAudio,
                  onDone: Machine.transition({
                    target: (to) => to.none(),
                    resolve: () => undefined
                  }),
                  onFailure: Machine.transition({
                    target: (to) => to.none(),
                    resolve: ({ error }, enqueue) => {
                      enqueue.raise(MediaPlayerInternalEvents.OperationFailed({ message: error.message }))
                      return undefined
                    }
                  })
                }),
                on: {
                  PlayRequested: Machine.transition({
                    target: (to) => to.local.Playing(),
                    resolve: ({ state, target }) =>
                      target.from({
                        ...updatePlaybackData(state, {}),
                        loudness: null
                      })
                  }),

                  RestartRequested: Machine.transition({
                    target: (to) => to.local.Restarting(),
                    resolve: ({ state, target }) => target.from(updatePlaybackData(state, {}))
                  })
                }
              },

              Playing: {
                invoke: [
                  MediaPlayerDefinition.invoke({
                    id: "play-audio",
                    effect: () => playAudio,
                    onDone: Machine.transition({
                      target: (to) => to.none(),
                      resolve: () => undefined
                    }),
                    onFailure: Machine.transition({
                      target: (to) => to.none(),
                      resolve: ({ error }, enqueue) => {
                        enqueue.raise(MediaPlayerInternalEvents.OperationFailed({ message: error.message }))
                        return undefined
                      }
                    })
                  }),
                  MediaPlayerDefinition.invoke({
                    id: "analyze-audio",
                    stream: () => analyzeAudio,
                    onElement: {
                      target: Machine.targetless,
                      resolve: ({ element }, enqueue) => {
                        enqueue.raise(MediaPlayerInternalEvents.LoudnessMeasured(element))
                      }
                    },
                    onDone: { target: Machine.targetless },
                    onFailure: {
                      target: Machine.targetless,
                      resolve: ({ error }, enqueue) => {
                        enqueue.raise(MediaPlayerInternalEvents.OperationFailed({ message: error.message }))
                      }
                    }
                  })
                ],
                on: {
                  PauseRequested: Machine.transition({
                    target: (to) => to.local.Paused(),
                    resolve: ({ state, target }) => target.from(updatePlaybackData(state, {}))
                  }),

                  RestartRequested: Machine.transition({
                    target: (to) => to.local.Restarting(),
                    resolve: ({ state, target }) => target.from(updatePlaybackData(state, {}))
                  }),

                  MediaWaiting: Machine.transition({
                    target: (to) => to.local.Buffering(),
                    resolve: ({ state, target }) => target.from(updatePlaybackData(state, {}))
                  }),

                  PlaybackEnded: Machine.transition({
                    target: (to) => to.local.Ended(),
                    resolve: ({ event, state, target }) =>
                      target.from(updatePlaybackData(state, { currentTime: event.currentTime }))
                  }),

                  TimeUpdated: Machine.transition({
                    target: (to) => to.local.Playing(),
                    resolve: ({ event, state, target }) =>
                      target.from({
                        currentTime: event.currentTime,
                        loudness: state.loudness
                      })
                  }),

                  LoudnessMeasured: Machine.transition({
                    target: (to) => to.local.Playing(),
                    resolve: ({ event, state, target }) =>
                      target.from({
                        currentTime: state.currentTime,
                        loudness: {
                          rms: event.rms,
                          peak: event.peak,
                          decibels: event.decibels
                        }
                      })
                  })
                }
              },

              Buffering: {
                on: {
                  MediaCanPlay: Machine.transition({
                    target: (to) => to.local.Playing(),
                    resolve: ({ state, target }) =>
                      target.from({
                        ...updatePlaybackData(state, {}),
                        loudness: null
                      })
                  }),

                  PauseRequested: Machine.transition({
                    target: (to) => to.local.Paused(),
                    resolve: ({ state, target }) => target.from(updatePlaybackData(state, {}))
                  }),

                  RestartRequested: Machine.transition({
                    target: (to) => to.local.Restarting(),
                    resolve: ({ state, target }) => target.from(updatePlaybackData(state, {}))
                  }),

                  PlaybackEnded: Machine.transition({
                    target: (to) => to.local.Ended(),
                    resolve: ({ event, state, target }) =>
                      target.from(updatePlaybackData(state, { currentTime: event.currentTime }))
                  }),

                  TimeUpdated: Machine.transition({
                    target: (to) => to.local.Buffering(),
                    resolve: ({ event, state, target }) =>
                      target.from(updatePlaybackData(state, { currentTime: event.currentTime }))
                  })
                }
              },

              Restarting: {
                invoke: MediaPlayerDefinition.invoke({
                  id: "restart-audio",
                  effect: () => restartAudio,
                  onDone: Machine.transition({
                    target: (to) => to.none(),
                    resolve: (_, enqueue) => {
                      enqueue.raise(MediaPlayerInternalEvents.RestartSucceeded())
                      return undefined
                    }
                  }),
                  onFailure: Machine.transition({
                    target: (to) => to.none(),
                    resolve: ({ error }, enqueue) => {
                      enqueue.raise(MediaPlayerInternalEvents.OperationFailed({ message: error.message }))
                      return undefined
                    }
                  })
                }),
                on: {
                  RestartSucceeded: Machine.transition({
                    target: (to) => to.local.Playing(),
                    resolve: ({ target }) => target.from({ currentTime: 0, loudness: null })
                  }),

                  TimeUpdated: Machine.transition({
                    target: (to) => to.local.Restarting(),
                    resolve: ({ event, state, target }) =>
                      target.from(updatePlaybackData(state, { currentTime: event.currentTime }))
                  })
                }
              },

              Ended: {
                on: {
                  PlayRequested: Machine.transition({
                    target: (to) => to.local.Restarting(),
                    resolve: ({ state, target }) => target.from(updatePlaybackData(state, {}))
                  }),

                  RestartRequested: Machine.transition({
                    target: (to) => to.local.Restarting(),
                    resolve: ({ state, target }) => target.from(updatePlaybackData(state, {}))
                  })
                }
              }
            }
          },

          Failed: {
            invoke: MediaPlayerDefinition.invoke({
              id: "report-error",
              effect: ({ state }) =>
                Effect.gen(function*() {
                  const mediaPlayer = yield* MediaPlayer
                  yield* mediaPlayer.reportError(state.message)
                }),
              onDone: Machine.transition({
                target: (to) => to.none(),
                resolve: () => undefined
              })
            })
          }
        }
      },

      settings: {
        states: {
          Audible: {
            invoke: MediaPlayerDefinition.invoke({
              id: "apply-audio-settings",
              effect: ({ state }) => applyAudioSettings(state, false),
              onDone: Machine.transition({
                target: (to) => to.none(),
                resolve: () => undefined
              })
            }),
            on: {
              VolumeChanged: Machine.transition({
                target: (to) => to.local.Audible(),
                resolve: ({ event, state, target }) =>
                  target.from({
                    volume: event.volume,
                    playbackRate: state.playbackRate
                  }),
                reenter: true
              }),

              PlaybackRateChanged: Machine.transition({
                target: (to) => to.local.Audible(),
                resolve: ({ event, state, target }) =>
                  target.from({
                    volume: state.volume,
                    playbackRate: event.playbackRate
                  }),
                reenter: true
              }),

              MuteRequested: Machine.transition({
                target: (to) => to.local.Muted(),
                resolve: ({ state, target }) =>
                  target.from({
                    volume: state.volume,
                    playbackRate: state.playbackRate
                  })
              })
            }
          },

          Muted: {
            invoke: MediaPlayerDefinition.invoke({
              id: "apply-audio-settings",
              effect: ({ state }) => applyAudioSettings(state, true),
              onDone: Machine.transition({
                target: (to) => to.none(),
                resolve: () => undefined
              })
            }),
            on: {
              VolumeChanged: Machine.transition({
                target: (to) => to.local.Muted(),
                resolve: ({ event, state, target }) =>
                  target.from({
                    volume: event.volume,
                    playbackRate: state.playbackRate
                  }),
                reenter: true
              }),

              PlaybackRateChanged: Machine.transition({
                target: (to) => to.local.Muted(),
                resolve: ({ event, state, target }) =>
                  target.from({
                    volume: state.volume,
                    playbackRate: event.playbackRate
                  }),
                reenter: true
              }),

              UnmuteRequested: Machine.transition({
                target: (to) => to.local.Audible(),
                resolve: ({ state, target }) =>
                  target.from({
                    volume: state.volume,
                    playbackRate: state.playbackRate
                  })
              })
            }
          }
        }
      }
    }
  }
})
