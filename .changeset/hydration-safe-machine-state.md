---
"@typeonce/effect-machine-react": minor
---

`MachineState` no longer suspends. Server rendering and hydration render the machine's planned startup snapshot, and the same tree then receives live snapshots, so hydrated form inputs keep their DOM nodes, typed text, and focus. Remove Suspense boundaries that only wrapped `MachineState` for its first paint.

Add the optional `pending` prop, rendered until the machine has a snapshot. Once a snapshot has rendered, `MachineState` keeps it while the machine is still starting, for example while a bound runtime layer builds after hydration:

```tsx
<MachineState machine={machine} path="Editing" pending={<Spinner />}>
  {(editing) => <input value={editing.value.email} onChange={onChange} />}
</MachineState>
```
