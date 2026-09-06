---
"@typeonce/effect-machine": minor
"@typeonce/effect-machine-react": minor
"@typeonce/effect-machine-devtools": minor
"@typeonce/oxlint-plugin-effect-machine": minor
---

Model each machine with one `Machine.state` root, passed to `Machine.make({ root })`. Root `fields` support data-only machines and shared data that survives child transitions. Replace the former top-level state map with a root descriptor, put child handlers under `handle({ states })`, and use `initial` for root values or `initialConfiguration` for a complete startup override. Add direct target construction, non-reentering `self.update`, and guards with ancestor fallback. Construct local event protocols from field records or import existing schemas with the explicit `FromSchemas` constructors.

Render typed state paths with React `MachineState` and own isolated instances with `createMachineContext(AtomMachine.factory(machine))`. Providers capture startup input without subscribing to state. Replace Atom bridge `.state` reads with `.result` or path selectors; `.snapshot` retains runtime status. Core `MachineRef.state` remains available. Testing runs and probes accept public deferred event inputs and record decoded receipts.

Encoded snapshots use version 2 and include the root at path `""`; explicitly migrate older persisted snapshots before decoding. Replace removed `Machine.Emit`, `Machine.Emits`, `Machine.EmitOf`, and `Machine.PseudoStateAnnotations` aliases with `EmittedEvent`, `EmittedEvents`, `EmittedEventOf`, and `SchemaLessStateAnnotations`.
