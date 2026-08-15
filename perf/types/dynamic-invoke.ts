import { Machine } from "@typeonce/effect-machine"
import { LoadError, loadUser, machine } from "./dynamic-invoke-control.js"

interface User {
  readonly id: string
  readonly name: string
}

const invoked = machine.handle({
  Loading: {
    invoke: Machine.invoke({
      id: "load-user",
      effect: ({ state }) => loadUser(state.userId),
      onDone: ({ output }) => {
        const user: User = output
        void user
      },
      onFailure: ({ error }) => {
        const loadError: LoadError = error
        void loadError
      }
    })
  }
})

void invoked
