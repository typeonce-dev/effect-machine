import type { Plugin } from "@oxlint/plugins"
import { noAsyncPlanningCallback } from "./internal/rules/noAsyncPlanningCallback.js"
import { noBrowserApiInPlanning } from "./internal/rules/noBrowserApiInPlanning.js"
import { noConditionalStayBranch } from "./internal/rules/noConditionalStayBranch.js"
import { noConflictingInvocationIdentity } from "./internal/rules/noConflictingInvocationIdentity.js"
import { noNondeterministicPlanning } from "./internal/rules/noNondeterministicPlanning.js"
import { preferInlineHandle } from "./internal/rules/preferInlineHandle.js"

const plugin = {
  meta: {
    name: "effect-machine"
  },
  rules: {
    "no-async-planning-callback": noAsyncPlanningCallback,
    "no-browser-api-in-planning": noBrowserApiInPlanning,
    "no-conditional-stay-branch": noConditionalStayBranch,
    "no-conflicting-invocation-identity": noConflictingInvocationIdentity,
    "no-nondeterministic-planning": noNondeterministicPlanning,
    "prefer-inline-handle": preferInlineHandle
  }
} satisfies Plugin

export { recommended } from "./recommended.js"

export default plugin
