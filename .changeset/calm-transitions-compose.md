---
"@typeonce/effect-machine": minor
"@typeonce/oxlint-plugin-effect-machine": patch
---

Construct atomic destination and retained-owner updates with `.updating(owner).from(({ current, event }) => ({ target, update }))`, or use `.decoded(...)` for decoded values. Both values are complete replacements; `.resolve(...)` remains available for explicit configuration builders and commands. Value updates and atomic transitions now support `.guard(...)`, declining before construction and commands while preserving ancestor fallback.

Use chainable `.reenter()` before `.from(...)`, `.decoded(...)`, or `.resolve(...)` to force source exit and entry. Replace `.resolve(callback, { reenter: true })` with `.reenter().resolve(callback)` and omit reentry entirely when it is false. Named branching transitions use `.branches(...).reenter().resolve(...)`. The redundant-resolver lint rule preserves these modifiers when simplifying default construction.
