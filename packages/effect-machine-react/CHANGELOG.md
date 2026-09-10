# @typeonce/effect-machine-react

## 0.36.0

### Patch Changes

- Updated dependencies [21fbf58]
  - @typeonce/effect-machine@0.36.0

## 0.35.0

### Minor Changes

- e72b7f5: Declare initial edges and data together in `.handle`. Remove `initial` from `Machine.state`, remove `initial` and `initialConfiguration` from `Machine.make`, and move shared startup data into the root handler's `root` value or input callback. Each compound declares `initial: { target, data? }`; parallel handlers use an `initial` map of region data. Initial targets must be direct children and remain inspectable without executing constructors.

  ```ts
  const root = Machine.state({ states: { Locked: {}, Unlocked: {} } });
  const targets = Machine.targets(root);
  const machine = Machine.make({
    root,
    events: Machine.events({ Coin: {} }),
  }).handle({
    initial: { target: targets.root.Locked },
    states: { Locked: { on: { Coin: { target: targets.root.Unlocked } } } },
  });
  ```

  Replace declarative `from` callbacks with `data`, which accepts literals or callbacks. Supply already-decoded values with `{ decoded: true, data: valueOrCallback }`. For root or region data that itself contains `decoded: true` and `data` fields, use a callback returning the ordinary schema input. Bound branch and history builders retain `.from` and `.decoded`. Replace command-producing `initialize` callbacks with `entry`/`exit` handlers or invocations; definitions become executable only after `.handle` captures their initial declarations.

### Patch Changes

- Updated dependencies [e72b7f5]
  - @typeonce/effect-machine@0.35.0

## 0.34.0

### Minor Changes

- c1b0693: Declare transitions as objects using references from `Machine.targets(Root)`. Replace event-local selector chains with `{ target: targets.root.Ready, from: ({ event }) => ({ value: event.value }) }`, and use `update` for retained state data. `initial`, `history`, `none: true`, `guard`, and `reenter` express their respective operations explicitly.

  Register `effects`, `streams`, `timers`, `logic`, and `children` inside `Machine.make`, then invoke them with `{ src, input?, onDone?, onFailure?, onElement?, onSnapshot? }`. Required inputs and reachable outcome handlers are checked from the source types; unused sources do not add service requirements. Pass lazy Effect and Stream values directly, or use a function with one required input and provide an input mapper.

  Declare named `branches` in `make` for conditional outcomes, queued commands, or nested construction. A transition uses `{ branches: "group", resolve }`; its `select` constructors come from the declared destinations. Ordinary transitions stay inline. Full root configuration construction remains available at initialization and history fallback; runtime transitions use explicit destinations and retained owner updates. Devtools, testing, React integrations, and lint rules follow the new declarations.

### Patch Changes

- Updated dependencies [a10e9be]
- Updated dependencies [c1b0693]
  - @typeonce/effect-machine@0.34.0

## 0.33.0

### Patch Changes

- Updated dependencies [3255f24]
  - @typeonce/effect-machine@0.33.0

## 0.32.0

### Minor Changes

- 1160040: Model each machine with one `Machine.state` root, passed to `Machine.make({ root })`. Root `fields` support data-only machines and shared data that survives child transitions. Replace the former top-level state map with a root descriptor, put child handlers under `handle({ states })`, and use `initial` for root values or `initialConfiguration` for a complete startup override. Add direct target construction, non-reentering `self.update`, and guards with ancestor fallback. Construct local event protocols from field records or import existing schemas with the explicit `FromSchemas` constructors.

  Render typed state paths with React `MachineState` and own isolated instances with `createMachineContext(AtomMachine.factory(machine))`. Providers capture startup input without subscribing to state. Replace Atom bridge `.state` reads with `.result` or path selectors; `.snapshot` retains runtime status. Core `MachineRef.state` remains available. Testing runs and probes accept public deferred event inputs and record decoded receipts.

  Encoded snapshots use version 2 and include the root at path `""`; explicitly migrate older persisted snapshots before decoding. Replace removed `Machine.Emit`, `Machine.Emits`, `Machine.EmitOf`, and `Machine.PseudoStateAnnotations` aliases with `EmittedEvent`, `EmittedEvents`, `EmittedEventOf`, and `SchemaLessStateAnnotations`.

### Patch Changes

- Updated dependencies [1160040]
- Updated dependencies [163be91]
  - @typeonce/effect-machine@0.32.0

## 0.31.2

### Patch Changes

- Updated dependencies [65e4722]
  - @typeonce/effect-machine@0.31.2

## 0.31.1

### Patch Changes

- @typeonce/effect-machine@0.31.1

## 0.31.0

### Patch Changes

- Updated dependencies [9ec7ef4]
  - @typeonce/effect-machine@0.31.0

## 0.30.0

### Patch Changes

- Updated dependencies [d1f921c]
  - @typeonce/effect-machine@0.30.0

## 0.29.0

### Minor Changes

- d739ebd: Add `@typeonce/effect-machine-react` with `useMachineAtom` for owning and mounting one stable machine atom without subscribing its React owner to machine state.

  Typed state-path projections now return the same atom for repeated calls with the same machine and path. Descendants can select state-owned data directly during render:

  ```tsx
  const machine = useMachineAtom(() => MachineAtoms.make(AuthMachine, input));
  const editing = useAtomSuspense(
    AtomMachine.selectSnapshot(machine, "Editing")
  ).value;
  ```

  Startup input is captured when React creates the owner. Send an event to update the running workflow, or change the owner's React key to replace the machine.

### Patch Changes

- Updated dependencies [d739ebd]
  - @typeonce/effect-machine@0.29.0
