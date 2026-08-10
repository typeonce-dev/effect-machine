import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { Effect } from "effect"
import { Atom } from "effect/unstable/reactivity"
import { MediaPlayerMachine } from "./machine.ts"
import { MediaPlayer } from "./service.ts"
import { toMediaPlayerView } from "./view.ts"

const mediaPlayerRuntime = Atom.runtime(MediaPlayer.layer)

export const mediaPlayerAtom = AtomMachine.bind(mediaPlayerRuntime).make(MediaPlayerMachine)

export const mediaPlayerViewAtom = Atom.mapResult(mediaPlayerAtom.snapshot, (snapshot) => ({
  status: snapshot.status,
  ...toMediaPlayerView(snapshot.state)
}))

export const registerMediaPlayerElement = mediaPlayerRuntime.fn((audioRef: HTMLAudioElement) =>
  Effect.gen(function*() {
    const mediaPlayer = yield* MediaPlayer
    yield* mediaPlayer.register(audioRef)
  })
)
