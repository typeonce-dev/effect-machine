import type { Plugin } from "@oxlint/plugins"
import { noAsyncPlanningCallback } from "./internal/rules/noAsyncPlanningCallback.js"
import { noRedundantResolve } from "./internal/rules/noRedundantResolve.js"
import { preferInlineHandle } from "./internal/rules/preferInlineHandle.js"

const plugin = {
  meta: {
    name: "effect-machine"
  },
  rules: {
    "no-async-planning-callback": noAsyncPlanningCallback,
    "no-redundant-resolve": noRedundantResolve,
    "prefer-inline-handle": preferInlineHandle
  }
} satisfies Plugin

export { recommended } from "./recommended.js"

export default plugin
