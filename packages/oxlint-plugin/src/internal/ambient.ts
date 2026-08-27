import type { Context, ESTree } from "@oxlint/plugins"
import { canonicalGlobalPath } from "./ast.js"

const scheduledFunctions = new Set([
  "fetch",
  "queueMicrotask",
  "requestAnimationFrame",
  "requestIdleCallback",
  "setImmediate",
  "setInterval",
  "setTimeout"
])

const promiseMethods = new Set([
  "all",
  "allSettled",
  "any",
  "race",
  "reject",
  "resolve",
  "try"
])

export const asyncOperation = (
  context: Context,
  node: ESTree.CallExpression | ESTree.NewExpression
): string | undefined => {
  const path = canonicalGlobalPath(context, node.callee)
  if (path === undefined) return undefined
  if (node.type === "NewExpression") {
    return path.length === 1 && path[0] === "Promise" ? "new Promise(...)" : undefined
  }
  if (path.length === 1 && scheduledFunctions.has(path[0]!)) return `${path[0]}(...)`
  if (path.length === 2 && path[0] === "Promise" && promiseMethods.has(path[1]!)) {
    return `Promise.${path[1]}(...)`
  }
  return path.length === 2 && path[0] === "process" && path[1] === "nextTick"
    ? "process.nextTick(...)"
    : undefined
}

export const nondeterministicOperation = (
  context: Context,
  node: ESTree.CallExpression | ESTree.NewExpression
): string | undefined => {
  const path = canonicalGlobalPath(context, node.callee)
  if (path === undefined) return undefined
  if (node.type === "NewExpression") {
    return path.length === 1 && path[0] === "Date" && node.arguments.length === 0
      ? "new Date()"
      : undefined
  }
  if (path.length === 1 && path[0] === "Date") return "Date()"
  if (path.length === 2 && path[0] === "Date" && path[1] === "now") return "Date.now()"
  if (path.length === 2 && path[0] === "Math" && path[1] === "random") return "Math.random()"
  if (
    path.length === 2 &&
    path[0] === "crypto" &&
    (path[1] === "getRandomValues" || path[1] === "randomUUID")
  ) return `crypto.${path[1]}(...)`
  if (path.length === 2 && path[0] === "performance" && path[1] === "now") {
    return "performance.now()"
  }
  if (path.length >= 3 && path[0] === "Temporal" && path[1] === "Now") {
    return `${path.join(".")}()`
  }
  if (
    path[0] === "process" &&
    (path.join(".") === "process.hrtime" ||
      path.join(".") === "process.hrtime.bigint" ||
      path.join(".") === "process.uptime")
  ) return `${path.join(".")}()`
  return undefined
}

export const nondeterministicProperty = (
  context: Context,
  node: ESTree.MemberExpression
): string | undefined => {
  const path = canonicalGlobalPath(context, node)
  return path?.length === 2 && path[0] === "performance" && path[1] === "timeOrigin"
    ? "performance.timeOrigin"
    : undefined
}

const browserRoots = new Set([
  "caches",
  "cookieStore",
  "document",
  "history",
  "indexedDB",
  "localStorage",
  "location",
  "navigator",
  "screen",
  "self",
  "sessionStorage",
  "visualViewport",
  "window"
])

const browserFunctions = new Set([
  "addEventListener",
  "alert",
  "confirm",
  "dispatchEvent",
  "getComputedStyle",
  "matchMedia",
  "open",
  "postMessage",
  "prompt",
  "removeEventListener"
])

const browserConstructors = new Set([
  "BroadcastChannel",
  "EventSource",
  "SharedWorker",
  "WebSocket",
  "Worker",
  "XMLHttpRequest"
])

export const browserApi = (
  context: Context,
  node: ESTree.Expression
): string | undefined => {
  const path = canonicalGlobalPath(context, node)
  if (path === undefined || path.length === 0) return undefined
  if (browserRoots.has(path[0]!) || browserFunctions.has(path[0]!) || browserConstructors.has(path[0]!)) {
    return path.join(".")
  }
  return undefined
}
