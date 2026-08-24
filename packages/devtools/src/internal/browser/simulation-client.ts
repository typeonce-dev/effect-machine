import * as Schema from "effect/Schema"
import * as DevToolsProtocol from "../../DevToolsProtocol.js"

export const requestSimulation = async (
  request: DevToolsProtocol.SimulationRequest
): Promise<DevToolsProtocol.SimulationResult> => {
  const response = await fetch("/api/simulations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request)
  })
  const body: unknown = await response.json()
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "message" in body
      ? String(body.message)
      : `Simulation request failed with status ${response.status}`
    throw new Error(message)
  }
  return Schema.decodeUnknownSync(DevToolsProtocol.SimulationResult)(body)
}
