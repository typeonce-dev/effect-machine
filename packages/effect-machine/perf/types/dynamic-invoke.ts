import { Machine } from "../../dist/index.js"
import { LoadError, Loading, loadUser, States } from "./dynamic-invoke-control.js"
interface User {
  readonly id: string
  readonly name: string
}
const machine = Machine.make({
  effects: { "load-user": loadUser },
  root: States,
  events: Machine.eventsFromSchemas()
})
const invoked = machine.handle({
  initial: {
    target: Machine.targets(States).root.Loading,
    data: Loading.make({ userId: "user-1" })
  },
  states: {
    Loading: {
      invoke: {
        src: "load-user",
        input: ({ state }) => state.userId,
        onDone: {
          none: true,
          resolve: ({ output }) => {
            const user: User = output
            void user
            return undefined
          }
        },
        onFailure: {
          none: true,
          resolve: ({ error }) => {
            const loadError: LoadError = error
            void loadError
            return undefined
          }
        }
      }
    }
  }
})
void invoked
