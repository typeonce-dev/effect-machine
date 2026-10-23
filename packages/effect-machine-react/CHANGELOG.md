# @typeonce/effect-machine-react

## 0.44.0

### Minor Changes

- 401fee7: `createMachineContext` factories now take one options object instead of positional parameters. Each option the factory declares, `input` or `layer`, is a Provider prop of the same name and type, so a machine that needs only a capability layer no longer declares a placeholder input. Options other than `input` and `layer` are rejected.

  A factory for a machine without input can still be passed directly, as in `createMachineContext(AtomMachine.factory(Machine))`. Factories that take input or a layer destructure them:

  ```tsx
  const Profile = createMachineContext(({ input }: { input: ProfileInput }) => AtomMachine.make(ProfileMachine, input))

  const Onboarding = createMachineContext(({ layer }: { layer: Layer.Layer<Navigation> }) =>
    AtomMachine.bind(Atom.runtime(Layer.provideMerge(layer, AppLayer))).make(OnboardingMachine)
  )

  <Onboarding.Provider layer={navigationLayer(router)} />
  ```

### Patch Changes

- @typeonce/effect-machine@0.44.0

## 0.43.0

### Minor Changes

- c9934ae: `MachineState` now renders child machines: pass a child bridge such as `machine.child(QuantityChild)` and the path and snapshot are typed by the child machine. `inactive` also renders while the state that owns the child is not active. `MachineStateProps` now takes the bridge type and the path, `MachineStateProps<A, Path>`.

  Add `useMachineResult(atom)` for custom readers of result atoms such as `AtomMachine.select`, `matches`, or `can`. It serves the planned value during server rendering and hydration and keeps the last success while the machine starts, so hydrated markup is not replaced. Add `AtomMachine.isMachineAtom` to tell machine bridges from child bridges.

  `createMachineContext` factories can declare a per-owner capability layer as a second parameter, and the Provider then requires a matching `layer` prop:

  ```tsx
  const SignIn = createMachineContext((input: SignInInput, navigation: Layer.Layer<Navigation>) =>
    AtomMachine.bind(Atom.runtime(Layer.provideMerge(navigation, AppLayer))).make(SignInMachine, input)
  )

  <SignIn.Provider input={input} layer={navigationLayer(router)} />
  ```

### Patch Changes

- 1d6c808: Serve referentially stable server values from machine atoms, so React no longer warns that `getServerSnapshot` should be cached while hydrating `MachineState` or other hooks that read machine atoms.
- Updated dependencies [c9934ae]
- Updated dependencies [1d6c808]
  - @typeonce/effect-machine@0.43.0

## 0.42.0

### Minor Changes

- 5eda754: `MachineState` no longer suspends. Server rendering and hydration render the machine's planned startup snapshot, and the same tree then receives live snapshots, so hydrated form inputs keep their DOM nodes, typed text, and focus. Remove Suspense boundaries that only wrapped `MachineState` for its first paint.

  Add the optional `pending` prop, rendered until the machine has a snapshot. Once a snapshot has rendered, `MachineState` keeps it while the machine is still starting, for example while a bound runtime layer builds after hydration:

  ```tsx
  <MachineState machine={machine} path="Editing" pending={<Spinner />}>
    {(editing) => <input value={editing.value.email} onChange={onChange} />}
  </MachineState>
  ```

### Patch Changes

- Updated dependencies [4e9d412]
- Updated dependencies [36b1c0a]
- Updated dependencies [71d41b9]
- Updated dependencies [5eda754]
- Updated dependencies [edebb70]
  - @typeonce/effect-machine@0.42.0

## 0.41.1

### Patch Changes

- 456c8b8: Accept Effect `^4.0.0` again. Effect 4.0.5 is not required: the `effect`, `@effect/atom-react`, and `@effect/platform-*` requirements return to `^4.0.0`, so projects on any stable Effect 4 release can install this version without upgrading Effect.
- Updated dependencies [456c8b8]
  - @typeonce/effect-machine@0.41.1

## 0.41.0

### Minor Changes

- c0d60f0: Require Effect 4.0.5 or newer. The `effect`, `@effect/atom-react`, and `@effect/platform-*` requirements now accept `^4.0.5`, which includes Effect's fix for repeated rebuilds of derived atoms.

  Upgrade `effect` and any installed `@effect/*` packages to matching 4.0.5 or newer versions.

### Patch Changes

- Updated dependencies [c0d60f0]
  - @typeonce/effect-machine@0.41.0

## 0.40.0

### Minor Changes

- 2d10472: Require stable Effect 4 across the core library, React integration, and devtools. Effect and `@effect/atom-react` peer requirements, and devtools platform dependencies, accept `^4.0.0`.

  Upgrade `effect` and any installed `@effect/*` packages from release candidates to matching stable 4.0 versions. React users must also upgrade `@effect/atom-react` to 4.0.0.

  Use Effect's new import paths in application code: `effect/reactivity`, `effect/cluster`, `effect/rpc`, and `effect/Arbitrary` replace their `effect/unstable/...` paths.

### Patch Changes

- Updated dependencies [2d10472]
  - @typeonce/effect-machine@0.40.0

## 0.39.0

### Patch Changes

- Updated dependencies [e20e054]
- Updated dependencies [86968b6]
  - @typeonce/effect-machine@0.39.0

## 0.38.1

### Patch Changes

- a3f54ab: Upgrade Effect and companion packages to `4.0.0-rc.117`. Install matching Effect packages when upgrading.
- Updated dependencies [a3f54ab]
  - @typeonce/effect-machine@0.38.1

## 0.38.0

### Minor Changes

- 36dde0f: Upgrade Effect and companion packages to `4.0.0-rc.116`. Install matching Effect packages when upgrading.

  `MachineTest.scenarios`, `finiteModels`, and `runtimeCommands` now produce native `Arbitrary` values from `effect/unstable/arbitrary/Arbitrary`. Custom input, event, and command generators must use that module instead of FastCheck. Use `Arbitrary.schema(schema)` for schema-derived generators, `Arbitrary.array` for sequences, and `Arbitrary.sampleEffect` or `Arbitrary.checkEffect` to sample and check them. In `@effect/vitest`, replace `fastCheck: { numRuns }` with `arbitrary: { runs }`. Generate new replay tokens; earlier FastCheck seeds and paths do not reproduce the same cases.

  Command sequences shrink by removing irrelevant commands while retaining the remaining values. Fix finite-model verification of exit and entry paths when an ancestor's initial choice resolves inside an active compound state.

### Patch Changes

- Updated dependencies [36dde0f]
  - @typeonce/effect-machine@0.38.0

## 0.37.0

### Patch Changes

- Updated dependencies [794a12a]
  - @typeonce/effect-machine@0.37.0

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
