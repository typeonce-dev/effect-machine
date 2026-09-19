---
"@typeonce/effect-machine": minor
"@typeonce/effect-machine-react": minor
"@typeonce/effect-machine-devtools": minor
---

Upgrade Effect and companion packages to `4.0.0-rc.116`. Install matching Effect packages when upgrading.

`MachineTest.scenarios`, `finiteModels`, and `runtimeCommands` now produce native `Arbitrary` values from `effect/unstable/arbitrary/Arbitrary`. Custom input, event, and command generators must use that module instead of FastCheck. Use `Arbitrary.schema(schema)` for schema-derived generators, `Arbitrary.array` for sequences, and `Arbitrary.sampleEffect` or `Arbitrary.checkEffect` to sample and check them. In `@effect/vitest`, replace `fastCheck: { numRuns }` with `arbitrary: { runs }`. Generate new replay tokens; earlier FastCheck seeds and paths do not reproduce the same cases.

Command sequences shrink by removing irrelevant commands while retaining the remaining values. Fix finite-model verification of exit and entry paths when an ancestor's initial choice resolves inside an active compound state.
