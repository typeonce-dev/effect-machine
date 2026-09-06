# @typeonce/effect-machine-react

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
