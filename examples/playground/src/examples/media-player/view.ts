import type { Machine } from "@typeonce/effect-machine"
import { Match } from "effect"
import { MediaPlayerMachine } from "./machine.ts"
import { initialPlaybackData, type LoudnessSample, type PlaybackData } from "./schemas.ts"

type MediaPlayerSnapshot = Machine.Machine.Snapshot<Machine.Machine.States<typeof MediaPlayerMachine>>
type TransportSnapshot = MediaPlayerSnapshot["states"]["transport"]["state"]
type ReadySnapshot = Extract<TransportSnapshot, { readonly path: "Player.transport.Ready" }>["state"]
type SettingsSnapshot = MediaPlayerSnapshot["states"]["settings"]["state"]

export type MediaPlayerTransportPath =
  | Exclude<TransportSnapshot["path"], "Player.transport.Ready">
  | ReadySnapshot["path"]

export interface MediaPlayerTransportView {
  readonly path: MediaPlayerTransportPath
  readonly name: "Empty" | "Loading" | "Paused" | "Playing" | "Buffering" | "Restarting" | "Ended" | "Failed"
  readonly value: TransportSnapshot["value"] | ReadySnapshot["value"]
  readonly playback: PlaybackData
  readonly loudness: LoudnessSample | null
  readonly error: string | null
  readonly isPlaying: boolean
  readonly isBuffering: boolean
  readonly canPlay: boolean
  readonly canPause: boolean
  readonly canRestart: boolean
}

export interface MediaPlayerSettingsView {
  readonly path: SettingsSnapshot["path"]
  readonly value: SettingsSnapshot["value"]
  readonly volume: number
  readonly playbackRate: number
  readonly muted: boolean
}

export interface MediaPlayerView {
  readonly transport: MediaPlayerTransportView
  readonly settings: MediaPlayerSettingsView
}

const transportDefaults = {
  playback: initialPlaybackData,
  loudness: null,
  error: null,
  isPlaying: false,
  isBuffering: false,
  canPlay: false,
  canPause: false,
  canRestart: false
} as const

const toReadyView = (snapshot: ReadySnapshot): MediaPlayerTransportView =>
  Match.value(snapshot).pipe(
    Match.discriminatorsExhaustive("path")({
      "Player.transport.Ready.Paused": ({ path, value }) => ({
        ...transportDefaults,
        path,
        name: "Paused" as const,
        value,
        playback: value,
        canPlay: true,
        canRestart: true
      }),
      "Player.transport.Ready.Playing": ({ path, value }) => ({
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
      "Player.transport.Ready.Buffering": ({ path, value }) => ({
        ...transportDefaults,
        path,
        name: "Buffering" as const,
        value,
        playback: value,
        isBuffering: true,
        canPause: true,
        canRestart: true
      }),
      "Player.transport.Ready.Restarting": ({ path, value }) => ({
        ...transportDefaults,
        path,
        name: "Restarting" as const,
        value,
        playback: value
      }),
      "Player.transport.Ready.Ended": ({ path, value }) => ({
        ...transportDefaults,
        path,
        name: "Ended" as const,
        value,
        playback: value,
        canPlay: true,
        canRestart: true
      })
    })
  )

const toTransportView = (snapshot: TransportSnapshot): MediaPlayerTransportView =>
  Match.value(snapshot).pipe(
    Match.discriminatorsExhaustive("path")({
      "Player.transport.Empty": ({ path, value }) => ({
        ...transportDefaults,
        path,
        name: "Empty" as const,
        value
      }),
      "Player.transport.Loading": ({ path, value }) => ({
        ...transportDefaults,
        path,
        name: "Loading" as const,
        value
      }),
      "Player.transport.Ready": ({ state }) => toReadyView(state),
      "Player.transport.Failed": ({ path, value }) => ({
        ...transportDefaults,
        path,
        name: "Failed" as const,
        value,
        error: value.message
      })
    })
  )

const toSettingsView = (snapshot: SettingsSnapshot): MediaPlayerSettingsView =>
  Match.value(snapshot).pipe(
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

export const toMediaPlayerView = (snapshot: MediaPlayerSnapshot): MediaPlayerView => ({
  transport: toTransportView(snapshot.states.transport.state),
  settings: toSettingsView(snapshot.states.settings.state)
})
