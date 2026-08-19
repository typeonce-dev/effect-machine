import { Machine } from "@typeonce/effect-machine"
import { initialAudioSettings, MediaPlayerEvents, MediaPlayerInternalEvents, MediaPlayerStates } from "./schemas.ts"

export { MediaPlayerEvents, MediaPlayerInternalEvents } from "./schemas.ts"

export const MediaPlayerDefinition = Machine.make({
  id: "MediaPlayer",
  states: MediaPlayerStates.states,
  events: MediaPlayerEvents,
  internalEvents: MediaPlayerInternalEvents,
  initial: (to) =>
    to.Player.initial.resolve(({ target }) =>
      target.from((player) =>
        player
          .transport.from((transport) => transport.Empty.from())
          .settings.from((settings) =>
            settings.Audible.from({
              volume: initialAudioSettings.volume,
              playbackRate: initialAudioSettings.playbackRate
            })
          )
      )
    )
})
