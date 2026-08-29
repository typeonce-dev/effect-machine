# @typeonce/effect-machine-react

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
