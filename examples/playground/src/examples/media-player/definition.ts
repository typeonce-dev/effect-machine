import { Machine } from "@typeonce/effect-machine"
import { initialAudioSettings, MediaPlayerEvent, MediaPlayerInternalEvent, MediaPlayerStates } from "./schemas.ts"

const initialPlayer = () =>
  MediaPlayerStates.initial.Player.from((player) =>
    player
      .transport.from((transport) => transport.Empty.from())
      .settings.from((settings) =>
        settings.Audible.from({
          volume: initialAudioSettings.volume,
          playbackRate: initialAudioSettings.playbackRate
        })
      )
  )

export const MediaPlayerDefinition = Machine.make({
  id: "MediaPlayer",
  states: MediaPlayerStates.states,
  events: [MediaPlayerEvent],
  internalEvents: [MediaPlayerInternalEvent],
  initial: initialPlayer
})

export const MediaPlayerEvents = Machine.events(MediaPlayerDefinition)
export const MediaPlayerInternalEvents = Machine.internalEvents(MediaPlayerDefinition)
