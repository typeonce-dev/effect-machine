/**
 * Renders the failure of a Cluster machine as the text its checkpoint stores.
 *
 * @since 0.48.0
 */
import type * as Cause from "effect/Cause"
import * as Inspectable from "effect/Inspectable"
import { ProcessLocalError } from "./errors.js"

const maxLength = 4096

const renderValue = (value: unknown): string => {
  if (value instanceof ProcessLocalError) {
    return `${value.operation} is process-local and is not supported`
  }
  if (!(value instanceof globalThis.Error)) return Inspectable.toStringUnknown(value, 0)
  // A tagged error without a message describes itself with its fields.
  const message = value.message === ""
    ? Inspectable.toStringUnknown(Object.fromEntries(Object.entries(value)), 0)
    : value.message
  return `${value.name}: ${message}${value.cause === undefined ? "" : ` (cause: ${renderValue(value.cause)})`}`
}

const renderReason = (reason: Cause.Reason<unknown>): string => {
  switch (reason._tag) {
    case "Fail":
      return renderValue(reason.error)
    case "Die":
      return renderValue(reason.defect)
    case "Interrupt":
      return "Interrupted"
  }
}

const bound = (text: string): string =>
  text.length <= maxLength
    ? text
    // A cut inside a surrogate pair would leave text that cannot be stored.
    : `${text.slice(0, maxLength - 1).replace(/[\uD800-\uDBFF]$/, "")}…`

/**
 * Renders a cause without its stack traces. Values that cannot be rendered do
 * not hide the failure.
 *
 * @internal
 */
export const renderFailure = (cause: Cause.Cause<unknown>): string => {
  try {
    return bound(cause.reasons.map(renderReason).join("\n"))
  } catch {
    return "A failure that cannot be rendered"
  }
}
