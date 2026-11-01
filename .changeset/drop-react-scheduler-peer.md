---
"@typeonce/effect-machine-react": patch
---

Remove the `scheduler` peer dependency from `@typeonce/effect-machine-react`.

The package never imports `scheduler`, so upgrading React no longer produces a peer warning from it. The `scheduler` version is now governed only by `react-dom` and `@effect/atom-react`. Remove `scheduler` from your dependencies if you installed it only for this package.
