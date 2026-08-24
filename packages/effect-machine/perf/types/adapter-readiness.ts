import { Atom } from "effect/unstable/reactivity"
import { Machine } from "../../dist/index.js"
import { ClusterMachine } from "../../dist/unstable/cluster/index.js"
import { AtomMachine } from "../../dist/unstable/reactivity/index.js"
import { machine, snapshot } from "./adapter-readiness-control.js"

type Equal<Left, Right> = (<Type>() => Type extends Left ? 1 : 2) extends (<Type>() => Type extends Right ? 1 : 2) ?
  true :
  false
type Expect<Value extends true> = Value
type IsAny<Value> = 0 extends 1 & Value ? true : false

const child = Machine.child("ready-child", machine)
const atom = AtomMachine.make(machine)
const resumedAtom = AtomMachine.resume(machine, snapshot)
const cluster = ClusterMachine.make("ReadyEntity", machine, { version: "1" })

declare const bound: AtomMachine.Bound<never>
const boundAtom = bound.make(machine)
const boundResumedAtom = bound.resume(machine, snapshot)

type StateIsNotAny = Expect<Equal<IsAny<Machine.Machine.States<typeof machine>>, false>>
type ErrorIsNotAny = Expect<Equal<IsAny<Machine.Machine.Error<typeof machine>>, false>>
type AtomEventIsExact = Expect<
  Equal<typeof atom.send extends Atom.Writable<any, infer Event> ? Event : unknown, never>
>
type BoundAtomEventIsExact = Expect<
  Equal<typeof boundAtom.send extends Atom.Writable<any, infer Event> ? Event : unknown, never>
>

void Machine.planInitial(machine)
void Machine.start(machine)
void Machine.resume(machine, snapshot)
void child
void resumedAtom
void cluster
void boundResumedAtom
export type { AtomEventIsExact, BoundAtomEventIsExact, ErrorIsNotAny, StateIsNotAny }
