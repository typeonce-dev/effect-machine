import { Effect, Schema } from "effect"
import { Machine } from "../../dist/index.js"

export class LoadError {
  readonly _tag = "LoadError"
}

export const Loading = Schema.TaggedStruct("Loading", { userId: Schema.String })

export const States = Machine.state({ initial: "Loading", states: { Loading } })

export const loadUser = (userId: string) => Effect.fail(new LoadError()).pipe(Effect.as({ id: userId, name: "Ada" }))

export const machine = Machine.make({
  root: States,
  events: Machine.eventsFromSchemas(),
  initialConfiguration: (root) =>
    root.resolve(({ target }) => target.from((to) => to.Loading.from(Loading.make({ userId: "user-1" }))))
})
