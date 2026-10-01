---
"@typeonce/effect-machine": minor
"@typeonce/effect-machine-react": minor
"@typeonce/effect-machine-devtools": minor
---

Require stable Effect 4.0 across the core library, React integration, and devtools. Effect and `@effect/atom-react` peer requirements now accept `^4.0.0`.

Upgrade `effect` and any installed `@effect/*` packages from release candidates to matching stable 4.0 versions. React users must also upgrade `@effect/atom-react` to 4.0.0.

Use Effect's new import paths in application code: `effect/reactivity`, `effect/cluster`, `effect/rpc`, and `effect/Arbitrary` replace their `effect/unstable/...` paths.
