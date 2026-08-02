import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

export const MediaPlayerState = Schema.TaggedUnion({
  Player: {},
  playback: {},
  Empty: {},
  Loading: {},
  Paused: {},
  Playing: {},
  Buffering: {},
  Ended: {},
  Failed: { message: Schema.String },
  volume: {},
  Audible: { volume: Schema.Number },
  Muted: { previousVolume: Schema.Number }
})

export const MediaPlayerEvent = Schema.TaggedUnion({
  SourceSelected: { url: Schema.String },
  PlayRequested: {},
  PauseRequested: {},
  MediaPlaying: {},
  MediaPaused: {},
  MediaWaiting: {},
  MediaCanPlay: {},
  MediaEnded: {},
  MediaFailed: { message: Schema.String },
  VolumeChanged: { volume: Schema.Number },
  MuteToggled: {}
})

export const MediaPlayerStates = Machine.defineStates({
  Player: {
    schema: MediaPlayerState.cases.Player,
    type: "parallel",
    states: {
      playback: {
        schema: MediaPlayerState.cases.playback,
        initial: "Empty",
        states: {
          Empty: MediaPlayerState.cases.Empty,
          Loading: MediaPlayerState.cases.Loading,
          Paused: MediaPlayerState.cases.Paused,
          Playing: MediaPlayerState.cases.Playing,
          Buffering: MediaPlayerState.cases.Buffering,
          Ended: MediaPlayerState.cases.Ended,
          Failed: MediaPlayerState.cases.Failed
        }
      },
      volume: {
        schema: MediaPlayerState.cases.volume,
        initial: "Audible",
        states: {
          Audible: MediaPlayerState.cases.Audible,
          Muted: MediaPlayerState.cases.Muted
        }
      }
    }
  }
})

const initialPlayer = () =>
  MediaPlayerStates.initial.Player(MediaPlayerState.cases.Player.make({}), (player) =>
    player
      .playback(
        MediaPlayerState.cases.playback.make({}),
        (playback) => playback.Empty(MediaPlayerState.cases.Empty.make({}))
      )
      .volume(
        MediaPlayerState.cases.volume.make({}),
        (volume) => volume.Audible(MediaPlayerState.cases.Audible.make({ volume: 1 }))
      ))

/**
 * The browser event protocol and parallel topology are ready. Keep calls to
 * HTMLAudioElement.play/pause in the React adapter (or staged actions), and
 * feed resulting DOM events back into this machine.
 */
export const MediaPlayerMachine = Machine.make({
  id: "MediaPlayer",
  states: MediaPlayerStates.states,
  events: [MediaPlayerEvent],
  initial: initialPlayer
}).handle({
  Player: {
    states: {
      playback: {
        states: {
          Empty: {},
          Loading: {},
          Paused: {},
          Playing: {},
          Buffering: {},
          Ended: {},
          Failed: {}
        }
      },
      volume: {
        states: {
          Audible: {},
          Muted: {}
        }
      }
    }
  }
})
