---
"@typeonce/effect-machine-devtools": patch
---

Install the devtools CLI without pinning a second exact TypeScript or Vite.

`@typeonce/effect-machine-devtools` now depends on `typescript` `>=5.9.0 <7.0.0` and `vite` `^8.1.5` instead of exact versions, so a package manager can reuse compatible versions your project already has. No setup changes are required: the CLI still works when your project uses neither, or uses TypeScript 7.
