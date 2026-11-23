import type { Machine } from "../../dist/index.js"
import { address, definition } from "./invocation-kinds-control.js"
const invoked = definition.handle({
  initial: { target: "Idle" },
  states: {
    Idle: {
      invoke: [
        { src: "feed", onElement: { target: "Reading", data: ({ element }) => element }, onDone: { stay: true } },
        { src: "worker", id: "worker", address, onDone: { stay: true } },
        { src: "child" }
      ]
    },
    Reading: {}
  }
})
export type Services = Machine.Machine.Services<typeof invoked>
