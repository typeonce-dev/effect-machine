import { assert, describe, it } from "@effect/vitest"
import { valueShape } from "../../../src/internal/browser/visualizer-app.js"

describe("Visualizer app", () => {
  it("reduces captured state schemas to a compact JSON-shaped type preview", () => {
    assert.deepStrictEqual(
      valueShape({
        dialect: "draft-2020-12",
        schema: { $ref: "#/$defs/Idle" },
        definitions: {
          Idle: {
            type: "object",
            properties: {
              _tag: { type: "string", enum: ["Idle"] },
              owner: { type: "string" },
              attempts: { type: "integer" },
              mode: { type: "string", enum: ["login", "signup"] },
              note: { type: "string" },
              tags: { type: "array", items: { type: "string" } }
            },
            required: ["_tag", "owner", "attempts", "mode", "tags"],
            additionalProperties: false
          }
        }
      }),
      {
        owner: "string",
        attempts: "integer",
        mode: "login | signup",
        "note?": "string",
        tags: ["string"]
      }
    )
  })
})
