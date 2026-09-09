# @typeonce/oxlint-plugin-effect-machine

## 0.34.0

### Minor Changes

- c1b0693: Declare transitions as objects using references from `Machine.targets(Root)`. Replace event-local selector chains with `{ target: targets.root.Ready, from: ({ event }) => ({ value: event.value }) }`, and use `update` for retained state data. `initial`, `history`, `none: true`, `guard`, and `reenter` express their respective operations explicitly.

  Register `effects`, `streams`, `timers`, `logic`, and `children` inside `Machine.make`, then invoke them with `{ src, input?, onDone?, onFailure?, onElement?, onSnapshot? }`. Required inputs and reachable outcome handlers are checked from the source types; unused sources do not add service requirements. Pass lazy Effect and Stream values directly, or use a function with one required input and provide an input mapper.

  Declare named `branches` in `make` for conditional outcomes, queued commands, or nested construction. A transition uses `{ branches: "group", resolve }`; its `select` constructors come from the declared destinations. Ordinary transitions stay inline. Full root configuration construction remains available at initialization and history fallback; runtime transitions use explicit destinations and retained owner updates. Devtools, testing, React integrations, and lint rules follow the new declarations.

## 0.33.0

### Patch Changes

- 3255f24: Construct atomic destination and retained-owner updates with `.updating(owner).from(({ current, event }) => ({ target, update }))`, or use `.decoded(...)` for decoded values. Both values are complete replacements; `.resolve(...)` remains available for explicit configuration builders and commands. Value updates and atomic transitions now support `.guard(...)`, declining before construction and commands while preserving ancestor fallback.

  Use chainable `.reenter()` before `.from(...)`, `.decoded(...)`, or `.resolve(...)` to force source exit and entry. Replace `.resolve(callback, { reenter: true })` with `.reenter().resolve(callback)` and omit reentry entirely when it is false. Named branching transitions use `.branches(...).reenter().resolve(...)`. The redundant-resolver lint rule preserves these modifiers when simplifying default construction.

## 0.32.0

### Minor Changes

- 1160040: Model each machine with one `Machine.state` root, passed to `Machine.make({ root })`. Root `fields` support data-only machines and shared data that survives child transitions. Replace the former top-level state map with a root descriptor, put child handlers under `handle({ states })`, and use `initial` for root values or `initialConfiguration` for a complete startup override. Add direct target construction, non-reentering `self.update`, and guards with ancestor fallback. Construct local event protocols from field records or import existing schemas with the explicit `FromSchemas` constructors.

  Render typed state paths with React `MachineState` and own isolated instances with `createMachineContext(AtomMachine.factory(machine))`. Providers capture startup input without subscribing to state. Replace Atom bridge `.state` reads with `.result` or path selectors; `.snapshot` retains runtime status. Core `MachineRef.state` remains available. Testing runs and probes accept public deferred event inputs and record decoded receipts.

  Encoded snapshots use version 2 and include the root at path `""`; explicitly migrate older persisted snapshots before decoding. Replace removed `Machine.Emit`, `Machine.Emits`, `Machine.EmitOf`, and `Machine.PseudoStateAnnotations` aliases with `EmittedEvent`, `EmittedEvents`, `EmittedEventOf`, and `SchemaLessStateAnnotations`.

### Patch Changes

- 163be91: Align `Machine.can` types with its existing support for public and internal events. Querying an internal event does not make it sendable through `MachineRef.send`. Preserve interruption during snapshot encoding and decoding, validate reused event and emission values, and capture machine definitions independently of caller mutations.

  Make `MachineTest.verify` lazy and compare decoded values without lossy JSON serialization. Serialize concurrent devtools refreshes, stop watcher work with its server scope, and prevent lint rules from matching shadowed machine bindings.

## 0.31.2

## 0.31.1

## 0.31.0

## 0.30.0

## 0.29.0

## 0.28.0

## 0.27.1

## 0.27.0

### Minor Changes

- 74111e2: Add recommended rules that reject duplicate invocation identities, browser API access during planning, and nondeterministic time or randomness during planning.

  Strengthen `no-async-planning-callback` to detect direct Promise, fetch, timer, and scheduling operations, and extend `no-redundant-resolve` fixes to resolver-only reentry and empty targetless resolvers. Diagnostics now explain how to move work into state-owned invocations, pass external facts through input or events, or model sequential work with separate states.

## 0.26.2

## 0.26.1

### Patch Changes

- 99c237b: Fix the published plugin entrypoints so Oxlint loads built JavaScript instead of TypeScript source under `node_modules`.

  Upgrade from `0.26.0` without changing the Oxlint configuration. Both the package root and the recommended configuration now resolve to built files.

## 0.26.0

### Minor Changes

- 4130963: Add `@typeonce/oxlint-plugin-effect-machine` with recommended rules for redundant default resolvers, asynchronous planning callbacks, and one-use intermediate `Machine.make(...)` definitions.

  All three Effect Machine packages now release at the same version.
