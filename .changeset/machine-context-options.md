---
"@typeonce/effect-machine-react": minor
---

`createMachineContext` factories now take one options object instead of positional parameters. Each option the factory declares, `input` or `layer`, is a Provider prop of the same name and type, so a machine that needs only a capability layer no longer declares a placeholder input. Options other than `input` and `layer` are rejected.

A factory for a machine without input can still be passed directly, as in `createMachineContext(AtomMachine.factory(Machine))`. Factories that take input or a layer destructure them:

```tsx
const Profile = createMachineContext(({ input }: { input: ProfileInput }) => AtomMachine.make(ProfileMachine, input))

const Onboarding = createMachineContext(({ layer }: { layer: Layer.Layer<Navigation> }) =>
  AtomMachine.bind(Atom.runtime(Layer.provideMerge(layer, AppLayer))).make(OnboardingMachine)
)

<Onboarding.Provider layer={navigationLayer(router)} />
```
