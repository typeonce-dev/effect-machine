import { Effect, Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"

class Loading extends Schema.TaggedClass<Loading>("InvocationArraysLoading")("Loading", {}) {}
class Ready extends Schema.TaggedClass<Ready>("InvocationArraysReady")("Ready", { value: Schema.Number }) {}
class Failed extends Schema.TaggedClass<Failed>("InvocationArraysFailed")("Failed", {}) {}
class LoadError extends Schema.TaggedClass<LoadError>("InvocationArraysLoadError")("LoadError", {}) {}

const machine = Machine.make({
  effects: { load: Effect.fail(new LoadError({})) as Effect.Effect<number, LoadError> },
  timers: { delay: "1 second" },
  root: Machine.state({ states: { Loading, Ready, Failed } }),
  events: Machine.eventsFromSchemas()
})

describe("invocation arrays", () => {
  it("accepts branches and resolve on an entry beside other invocations", () => {
    expect(machine.handle({
      initial: { target: "Loading" },
      states: {
        Loading: {
          invoke: [
            { src: "delay", onDone: { target: "Failed" } },
            {
              src: "load",
              onDone: {
                branches: [{ target: "Ready" }, { target: "Failed" }],
                resolve: ({ output, select }) => {
                  expect(output).type.toBe<number>()
                  return output > 0
                    ? select.target("Ready", { data: new Ready({ value: output }) })
                    : select.target("Failed")
                }
              },
              onFailure: {
                branches: [{ target: "Failed" }, { stay: true }],
                resolve: ({ error, select }) => {
                  expect(error).type.toBe<LoadError>()
                  return Math.random() > 0.5 ? select.target("Failed") : select.stay()
                }
              }
            }
          ]
        },
        Ready: {},
        Failed: {}
      }
    })).type.not.toRaiseError()
  })

  it("still rejects unknown targets in every entry", () => {
    expect(machine.handle({
      initial: { target: "Loading" },
      states: {
        Loading: {
          invoke: [
            { src: "delay", onDone: { target: "Failed" } },
            {
              src: "load",
              onDone: {
                branches: [{ target: "Ready" }, { target: "Failed" }],
                resolve: ({ output, select }) =>
                  output > 0
                    ? select.target("Ready", { data: new Ready({ value: output }) })
                    : select.target("Failed")
              },
              onFailure: { target: "Missing" }
            }
          ]
        },
        Ready: {},
        Failed: {}
      }
    })).type.toRaiseError(`Unknown target \\"Missing\\". Declared: Loading, Ready, Failed`)
    expect(machine.handle({
      initial: { target: "Loading" },
      states: {
        Loading: {
          invoke: [
            { src: "delay", onDone: { target: "Missing" } },
            {
              src: "load",
              onDone: {
                branches: [{ target: "Ready" }, { target: "Failed" }],
                resolve: ({ output, select }) =>
                  output > 0
                    ? select.target("Ready", { data: new Ready({ value: output }) })
                    : select.target("Failed")
              },
              onFailure: { target: "Failed" }
            }
          ]
        },
        Ready: {},
        Failed: {}
      }
    })).type.toRaiseError(`Unknown target \\"Missing\\". Declared: Loading, Ready, Failed`)
  })
})
