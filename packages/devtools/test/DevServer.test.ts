import { assert, describe, it } from "@effect/vitest"
import { watcherOptions } from "../src/internal/devServer.js"

describe("DevServer", () => {
  it("uses native file-system events unless polling is requested", () => {
    const options = { root: "/project", host: "127.0.0.1", port: 5173 }
    assert.strictEqual(watcherOptions(options).backend, "auto")
    assert.strictEqual(watcherOptions({ ...options, watchPolling: false }).backend, "auto")
    assert.strictEqual(watcherOptions({ ...options, watchPolling: true }).backend, "polling")
  })
})
