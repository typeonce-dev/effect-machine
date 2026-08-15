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
      onDone: ({ output, target }) => {
        const user: User = output
        void user
        return target.none()
      },
      onFailure: ({ error, target }) => {
        const loadError: LoadError = error
        void loadError
        return target.none()
      }
    })
  }
})

void invoked
