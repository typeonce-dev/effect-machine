---
"@typeonce/effect-machine": minor
"@typeonce/effect-machine-react": minor
"@typeonce/effect-machine-devtools": minor
"@typeonce/oxlint-plugin-effect-machine": minor
---

Declare transitions as objects using references from `Machine.targets(Root)`. Replace event-local selector chains with `{ target: targets.root.Ready, from: ({ event }) => ({ value: event.value }) }`, and use `update` for retained state data. `initial`, `history`, `none: true`, `guard`, and `reenter` express their respective operations explicitly.

Register `effects`, `streams`, `timers`, `logic`, and `children` inside `Machine.make`, then invoke them with `{ src, input?, onDone?, onFailure?, onElement?, onSnapshot? }`. Required inputs and reachable outcome handlers are checked from the source types; unused sources do not add service requirements. Pass lazy Effect and Stream values directly, or use a function with one required input and provide an input mapper.

Declare named `branches` in `make` for conditional outcomes, queued commands, or nested construction. A transition uses `{ branches: "group", resolve }`; its `select` constructors come from the declared destinations. Ordinary transitions stay inline. Full root configuration construction remains available at initialization and history fallback; runtime transitions use explicit destinations and retained owner updates. Devtools, testing, React integrations, and lint rules follow the new declarations.
