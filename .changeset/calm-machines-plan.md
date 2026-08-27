---
"@typeonce/oxlint-plugin-effect-machine": minor
---

Add recommended rules that reject duplicate invocation identities, browser API access during planning, and nondeterministic time or randomness during planning.

Strengthen `no-async-planning-callback` to detect direct Promise, fetch, timer, and scheduling operations, and extend `no-redundant-resolve` fixes to resolver-only reentry and empty targetless resolvers. Diagnostics now explain how to move work into state-owned invocations, pass external facts through input or events, or model sequential work with separate states.
