import { Machine } from "@typeonce/effect-machine"
import { Effect, Schema } from "effect"

export class LoadError {
  readonly _tag = "LoadError"
}

export const Loading = Schema.TaggedStruct("Loading", { userId: Schema.String })

export const States = Machine.states({ Loading })

export const loadUser = (userId: string) => Effect.fail(new LoadError()).pipe(Effect.as({ id: userId, name: "Ada" }))

export const machine = Machine.make({
  states: States.states,
  events: Machine.events(),
  initial: (to) => to.Loading().resolve(({ target }) => target(Loading.make({ userId: "user-1" })))
})
