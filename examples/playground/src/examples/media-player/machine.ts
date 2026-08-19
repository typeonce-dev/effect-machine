import { Machine } from "@typeonce/effect-machine"
import { Effect, Match, Schema, Stream } from "effect"
import { MediaPlayer } from "./service.ts"

interface PlaybackData {
  readonly currentTime: number
}

const State = Schema.TaggedUnion({
  Loading: { url: Schema.String },
  Paused: { currentTime: Schema.Number },
  Playing: {
    currentTime: Schema.Number,
    loudness: Schema.NullOr(Schema.Struct({
      rms: Schema.Number,
      peak: Schema.Number,
      decibels: Schema.Number
    }))
  },
  Buffering: { currentTime: Schema.Number },
  Restarting: { currentTime: Schema.Number },
  Ended: { currentTime: Schema.Number },
  Failed: { message: Schema.String },
  Audible: {
    volume: Schema.Number,
    playbackRate: Schema.Number
  },
  Muted: {
    volume: Schema.Number,
    playbackRate: Schema.Number
  }
})

export const MediaPlayerEvents = Machine.events(
  Schema.TaggedUnion({
    AudioElementMounted: {},
    AudioElementUnmounted: {},
    SourceSelected: { url: Schema.String },
    PlayRequested: {},
    PauseRequested: {},
    RestartRequested: {},
    VolumeChanged: { volume: Schema.Number },
    PlaybackRateChanged: { playbackRate: Schema.Number },
    MuteRequested: {},
    UnmuteRequested: {}
  })
)

const MediaPlayerInternalEvents = Machine.internalEvents(
  Schema.TaggedUnion({
    LoadSucceeded: {},
    RestartSucceeded: {},
    MediaWaiting: {},
    MediaCanPlay: {},
    PlaybackEnded: { currentTime: Schema.Number },
    TimeUpdated: { currentTime: Schema.Number },
    MediaFailed: { message: Schema.String },
    LoudnessMeasured: {
      rms: Schema.Number,
      peak: Schema.Number,
      decibels: Schema.Number
    },
    OperationFailed: { message: Schema.String }
  })
)

const MediaPlayerStates = Machine.states({
  Player: {
    type: "parallel",
    states: {
      session: {
        initial: "Unregistered",
        states: {
          Unregistered: {},
          Registered: {
            initial: "Empty",
            states: {
              Empty: {},
              Loading: State.cases.Loading,
              Ready: {
                initial: "Paused",
                states: {
                  Paused: State.cases.Paused,
                  Playing: State.cases.Playing,
                  Buffering: State.cases.Buffering,
                  Restarting: State.cases.Restarting,
                  Ended: State.cases.Ended
                }
              },
              Failed: State.cases.Failed
            }
          }
        }
      },
      settings: {
        initial: "Audible",
        states: {
          Audible: State.cases.Audible,
          Muted: State.cases.Muted
        }
      }
    }
  }
})

const updatePlaybackData = (
  state: PlaybackData,
  patch: Partial<PlaybackData>
): PlaybackData => ({
  currentTime: patch.currentTime ?? state.currentTime
})

export const MediaPlayerMachine = Machine.make({
  id: "MediaPlayer",
  states: MediaPlayerStates.states,
  events: MediaPlayerEvents,
  internalEvents: MediaPlayerInternalEvents,
  initial: (to) =>
    to.Player.initial.resolve(({ target }) =>
      target.from((player) =>
        player
          .session.from((session) => session.Unregistered.from())
          .settings.from((settings) =>
            settings.Audible.from({
              volume: 1,
              playbackRate: 1
            })
          )
      )
    )
}).handle({
  Player: {
    states: {
      session: {
        on: {
          AudioElementMounted: (to) =>
            to.local.Registered.initial.resolve(({ target }) => target.from(), { reenter: true }),
          AudioElementUnmounted: (to) =>
            to.local.Unregistered().resolve(({ target }) => target.from(), { reenter: true })
        },
        states: {
          Unregistered: {},

          Registered: {
            invoke: (from) =>
              from.stream("media-element-events", () =>
                Stream.unwrap(
                  Effect.map(MediaPlayer, (mediaPlayer) => mediaPlayer.events)
                )).onElement((to) =>
                  to.none.resolve(({ element }, enqueue) => {
                    Match.value(element).pipe(
                      Match.tagsExhaustive({
                        Waiting: () => enqueue.raise(MediaPlayerInternalEvents.MediaWaiting()),
                        CanPlay: () => enqueue.raise(MediaPlayerInternalEvents.MediaCanPlay()),
                        Ended: ({ currentTime }) =>
                          enqueue.raise(MediaPlayerInternalEvents.PlaybackEnded({ currentTime })),
                        TimeUpdated: ({ currentTime }) =>
                          enqueue.raise(MediaPlayerInternalEvents.TimeUpdated({ currentTime })),
                        Failed: ({ message }) => enqueue.raise(MediaPlayerInternalEvents.MediaFailed({ message }))
                      })
                    )
                  })
                ).onDone((to) => to.none).onFailure((to) =>
                  to.local.Failed().resolve(({ error, target }) => target.from({ message: error.message }))
                ),
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
                  from.effect("load-audio", ({ state }) =>
                    Effect.gen(function*() {
                      const mediaPlayer = yield* MediaPlayer
                      yield* mediaPlayer.load(state.url)
                    })).onDone((to) =>
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
                  LoadSucceeded: (to) => to.local.Ready.initial
                }
              },

              Ready: {
                initialize: ({ builder }) => builder.from({ currentTime: 0 }),
                states: {
                  Paused: {
                    invoke: (from) =>
                      from.effect("pause-audio", () =>
                        Effect.gen(function*() {
                          const mediaPlayer = yield* MediaPlayer
                          yield* mediaPlayer.pause
                        })).onDone((to) => to.none).onFailure((to) =>
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
                      from.effect("play-audio", () =>
                        Effect.gen(function*() {
                          const mediaPlayer = yield* MediaPlayer
                          yield* mediaPlayer.play
                        })).onDone((to) => to.none).onFailure((to) =>
                          to.none.resolve(({ error }, enqueue) => {
                            enqueue.raise(MediaPlayerInternalEvents.OperationFailed({ message: error.message }))
                            return undefined
                          })
                        ),
                      from.stream("analyze-audio", () =>
                        Stream.unwrap(
                          Effect.map(MediaPlayer, (mediaPlayer) => mediaPlayer.loudness)
                        )).onElement((to) =>
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
                        to.local.Restarting().resolve(({ state, target }) =>
                          target.from(updatePlaybackData(state, {}))
                        ),

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
                        to.local.Restarting().resolve(({ state, target }) =>
                          target.from(updatePlaybackData(state, {}))
                        ),

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
                      from.effect("restart-audio", () =>
                        Effect.gen(function*() {
                          const mediaPlayer = yield* MediaPlayer
                          yield* mediaPlayer.restart
                        })).onDone((to) =>
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
                        to.local.Restarting().resolve(({ state, target }) =>
                          target.from(updatePlaybackData(state, {}))
                        ),

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
          }
        }
      },

      settings: {
        initialize: ({ builder }) =>
          builder.from({
            volume: 1,
            playbackRate: 1
          }),
        states: {
          Audible: {
            invoke: (from) =>
              from.effect("apply-audio-settings", ({ state }) =>
                Effect.gen(function*() {
                  const mediaPlayer = yield* MediaPlayer
                  yield* mediaPlayer.applySettings({ ...state, muted: false })
                })).onDone((to) => to.none),
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
              from.effect("apply-audio-settings", ({ state }) =>
                Effect.gen(function*() {
                  const mediaPlayer = yield* MediaPlayer
                  yield* mediaPlayer.applySettings({ ...state, muted: true })
                })).onDone((to) => to.none),
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
