---
"@typeonce/effect-machine": minor
---

Deliver `send` and `stop` writes made while an atom machine is still starting. Writes to `MachineAtom.send`, `MachineAtom.stop`, `ChildMachineAtom.send` and `ChildMachineAtom.stop` before readiness are now held and delivered in write order once the machine is ready, instead of being dropped. The write result stays waiting until delivery and fails with the startup error if startup fails. Writes after the machine stopped still fail with `StoppedError`, and child writes still fail with `ChildNotActiveError` when the owning state is inactive.

`NotReadyError` is removed from `AtomMachine` and from the `send` and `stop` failure types. Remove any handling of it.

Add `AtomMachine.MachineAtom.Any` and `AtomMachine.ChildMachineAtom.Any` for code that accepts any bridge, including bridges for machines without events, and the `MachineAtom.State`, `MachineAtom.Event` and `ChildMachineAtom.State` extractors:

```ts
type Bridge = AtomMachine.MachineAtom.Any
type State = AtomMachine.MachineAtom.State<typeof CounterMachineAtom>
type Event = AtomMachine.MachineAtom.Event<typeof CounterMachineAtom>
```
