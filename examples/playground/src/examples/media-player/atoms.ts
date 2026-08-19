import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { Effect, Match } from "effect"
import { Atom } from "effect/unstable/reactivity"
import { MediaPlayerEvents, MediaPlayerMachine } from "./machine.ts"
import { MediaPlayer } from "./service.ts"

const mediaPlayerRuntime = Atom.runtime(MediaPlayer.layer)

export const mediaPlayerAtom = AtomMachine.bind(mediaPlayerRuntime).make(MediaPlayerMachine)

export const setMediaPlayerElement = mediaPlayerRuntime.fn((audioRef: HTMLAudioElement | null, get) =>
  Effect.gen(function*() {
    const mediaPlayer = yield* MediaPlayer
    yield* mediaPlayer.register(audioRef)
    yield* get.setResult(
      mediaPlayerAtom.send,
      audioRef === null ? MediaPlayerEvents.AudioElementUnmounted() : MediaPlayerEvents.AudioElementMounted()
    )
  })
)

export const mediaPlayerViewAtom = Atom.mapResult(mediaPlayerAtom.snapshot, ({ state, status }) => {
  const transportDefaults = {
    playback: { currentTime: 0 },
    loudness: null,
    error: null,
    isPlaying: false,
    isBuffering: false,
    canPlay: false,
    canPause: false,
    canRestart: false
  } as const

  const session = state.states.session.state

  const transport = session.path === "Player.session.Registered"
    ? Match.value(session.state).pipe(
      Match.discriminatorsExhaustive("path")({
        "Player.session.Registered.Empty": ({ path, value }) => ({
          ...transportDefaults,
          path,
          name: "Empty" as const,
          value
        }),
        "Player.session.Registered.Loading": ({ path, value }) => ({
          ...transportDefaults,
          path,
          name: "Loading" as const,
          value
        }),
        "Player.session.Registered.Ready": ({ state }) =>
          Match.value(state).pipe(
            Match.discriminatorsExhaustive("path")({
              "Player.session.Registered.Ready.Paused": ({ path, value }) => ({
                ...transportDefaults,
                path,
                name: "Paused" as const,
                value,
                playback: value,
                canPlay: true,
                canRestart: true
              }),
              "Player.session.Registered.Ready.Playing": ({ path, value }) => ({
                ...transportDefaults,
                path,
                name: "Playing" as const,
                value,
                playback: value,
                loudness: value.loudness,
                isPlaying: true,
                canPause: true,
                canRestart: true
              }),
              "Player.session.Registered.Ready.Buffering": ({ path, value }) => ({
                ...transportDefaults,
                path,
                name: "Buffering" as const,
                value,
                playback: value,
                isBuffering: true,
                canPause: true,
                canRestart: true
              }),
              "Player.session.Registered.Ready.Restarting": ({ path, value }) => ({
                ...transportDefaults,
                path,
                name: "Restarting" as const,
                value,
                playback: value
              }),
              "Player.session.Registered.Ready.Ended": ({ path, value }) => ({
                ...transportDefaults,
                path,
                name: "Ended" as const,
                value,
                playback: value,
                canPlay: true,
                canRestart: true
              })
            })
          ),
        "Player.session.Registered.Failed": ({ path, value }) => ({
          ...transportDefaults,
          path,
          name: "Failed" as const,
          value,
          error: value.message
        })
      })
    )
    : {
      ...transportDefaults,
      path: session.path,
      name: "Unavailable" as const,
      value: session.value
    }

  return {
    status,
    session: session.path,
    transport,
    settings: Match.value(state.states.settings.state).pipe(
      Match.discriminatorsExhaustive("path")({
        "Player.settings.Audible": ({ path, value }) => ({
          path,
          value,
          volume: value.volume,
          playbackRate: value.playbackRate,
          muted: false
        }),
        "Player.settings.Muted": ({ path, value }) => ({
          path,
          value,
          volume: value.volume,
          playbackRate: value.playbackRate,
          muted: true
        })
      })
    )
  }
})
