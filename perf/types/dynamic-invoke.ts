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
      onDone: Machine.transition({
        target: (to) => to.none(),
        resolve: ({ output }) => {
          const user: User = output
          void user
          return undefined
        }
      }),
      onFailure: Machine.transition({
        target: (to) => to.none(),
        resolve: ({ error }) => {
          const loadError: LoadError = error
          void loadError
          return undefined
        }
      })
    })
  }
})

void invoked
