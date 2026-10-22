---
"@typeonce/effect-machine": minor
"@typeonce/effect-machine-react": minor
---

`MachineState` now renders child machines: pass a child bridge such as `machine.child(QuantityChild)` and the path and snapshot are typed by the child machine. `inactive` also renders while the state that owns the child is not active. `MachineStateProps` now takes the bridge type and the path, `MachineStateProps<A, Path>`.

Add `useMachineResult(atom)` for custom readers of result atoms such as `AtomMachine.select`, `matches`, or `can`. It serves the planned value during server rendering and hydration and keeps the last success while the machine starts, so hydrated markup is not replaced. Add `AtomMachine.isMachineAtom` to tell machine bridges from child bridges.

`createMachineContext` factories can declare a per-owner capability layer as a second parameter, and the Provider then requires a matching `layer` prop:

```tsx
const SignIn = createMachineContext((input: SignInInput, navigation: Layer.Layer<Navigation>) =>
  AtomMachine.bind(Atom.runtime(Layer.provideMerge(navigation, AppLayer))).make(SignInMachine, input)
)

<SignIn.Provider input={input} layer={navigationLayer(router)} />
```
