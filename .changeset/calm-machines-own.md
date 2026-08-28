---
"@typeonce/effect-machine": minor
"@typeonce/effect-machine-react": minor
---

Add `@typeonce/effect-machine-react` with `useMachineAtom` for owning and mounting one stable machine atom without subscribing its React owner to machine state.

Typed state-path projections now return the same atom for repeated calls with the same machine and path. Descendants can select state-owned data directly during render:

```tsx
const machine = useMachineAtom(() => MachineAtoms.make(AuthMachine, input))
const editing = useAtomSuspense(AtomMachine.selectSnapshot(machine, "Editing")).value
```

Startup input is captured when React creates the owner. Send an event to update the running workflow, or change the owner's React key to replace the machine.
