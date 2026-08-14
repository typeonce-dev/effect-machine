import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

export interface AudioSettings {
  readonly volume: number
  readonly muted: boolean
  readonly playbackRate: number
}

export interface SoundSettings {
  readonly volume: number
  readonly playbackRate: number
}

export interface LoudnessSample {
  readonly rms: number
  readonly peak: number
  readonly decibels: number
}

export interface PlaybackData {
  readonly currentTime: number
}

export interface PlayingData extends PlaybackData {
  readonly loudness: LoudnessSample | null
}

const Loudness = Schema.Struct({
  rms: Schema.Number,
  peak: Schema.Number,
  decibels: Schema.Number
})

const playbackFields = { currentTime: Schema.Number }

const soundSettingsFields = {
  volume: Schema.Number,
  playbackRate: Schema.Number
}

export const MediaPlayerState = Schema.TaggedUnion({
  Loading: { url: Schema.String },

  Paused: playbackFields,

  Playing: {
    ...playbackFields,
    loudness: Schema.NullOr(Loudness)
  },

  Buffering: playbackFields,

  Restarting: playbackFields,

  Ended: playbackFields,

  Failed: { message: Schema.String },

  Audible: soundSettingsFields,

  Muted: soundSettingsFields
})

export const MediaPlayerEvent = Schema.TaggedUnion({
  SourceSelected: { url: Schema.String },
  PlayRequested: {},
  PauseRequested: {},
  RestartRequested: {},
  MediaWaiting: {},
  MediaCanPlay: {},
  PlaybackEnded: { currentTime: Schema.Number },
  TimeUpdated: { currentTime: Schema.Number },
  MediaFailed: { message: Schema.String },
  VolumeChanged: { volume: Schema.Number },
  PlaybackRateChanged: { playbackRate: Schema.Number },
  MuteRequested: {},
  UnmuteRequested: {}
})

export const MediaPlayerInternalEvent = Schema.TaggedUnion({
  LoadSucceeded: {},
  RestartSucceeded: {},
  LoudnessMeasured: {
    rms: Schema.Number,
    peak: Schema.Number,
    decibels: Schema.Number
  },
  OperationFailed: { message: Schema.String }
})

export const MediaPlayerStates = Machine.defineStates({
  Player: {
    type: "parallel",
    states: {
      transport: {
        initial: "Empty",
        states: {
          Empty: {},

          Loading: MediaPlayerState.cases.Loading,

          Ready: {
            initial: "Paused",
            states: {
              Paused: MediaPlayerState.cases.Paused,

              Playing: MediaPlayerState.cases.Playing,

              Buffering: MediaPlayerState.cases.Buffering,

              Restarting: MediaPlayerState.cases.Restarting,

              Ended: MediaPlayerState.cases.Ended
            }
          },

          Failed: MediaPlayerState.cases.Failed
        }
      },

      settings: {
        initial: "Audible",
        states: {
          Audible: MediaPlayerState.cases.Audible,

          Muted: MediaPlayerState.cases.Muted
        }
      }
    }
  }
})

export const initialPlaybackData: PlaybackData = {
  currentTime: 0
}

export const initialAudioSettings: AudioSettings = {
  volume: 1,
  muted: false,
  playbackRate: 1
}

export const updatePlaybackData = (
  state: PlaybackData,
  patch: Partial<PlaybackData>
): PlaybackData => ({
  currentTime: patch.currentTime ?? state.currentTime
})

export const toAudioSettings = (
  settings: SoundSettings,
  muted: boolean
): AudioSettings => ({
  volume: settings.volume,
  muted,
  playbackRate: settings.playbackRate
})
