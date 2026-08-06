import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { Atom } from "effect/unstable/reactivity"
import { MediaPlayerMachine } from "./machine.ts"
import { MediaPlayer } from "./service.ts"

const mediaPlayerRuntime = Atom.runtime(MediaPlayer.layer)

export const mediaPlayerAtom = AtomMachine.bind(mediaPlayerRuntime).make(MediaPlayerMachine)
