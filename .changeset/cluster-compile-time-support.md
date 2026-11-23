---
"@typeonce/effect-machine": minor
---

`ClusterMachine.make` no longer compiles for a machine that Cluster cannot run: one whose states invoke a Stream, a `Logic`, or a child machine, or whose work requires `Machine.MachineRuntime`. These machines compiled before, and then rejected every request or failed while running. The error lists everything to replace:

```ts
// "~effect/ClusterMachine/UnsupportedProcessLocal": {
//   readonly invocations: "Stream" | "Child"
//   readonly capabilities: "MachineRuntime"
// }
ClusterMachine.make("Sensor", machine, { version: "1" })
```

When the compiler refuses a machine, replace the listed work with an Effect or a timer, or run the machine with `LocalMachine` or `AtomMachine`. A source that is registered and never invoked is accepted. Machines whose requirements are `any` are still checked at run time only.

The requirements of a machine, `Machine.Machine.Services`, now say what its host must support. How a machine is written does not change, and neither does what `LocalMachine` and `AtomMachine` require.

- The new `Machine.InvocationSupport<"Stream" | "Logic" | "Child">` is required once for each of these kinds that a state, or a child machine it invokes, invokes.
- `Machine.MachineRuntime` is required only when the invoked work uses it, instead of by every machine that invokes work.

Update a machine type that names `Machine.MachineRuntime` in its requirements to match. `LocalMachine.RequiredServices` removes all of these requirements, so use it instead of `Exclude<R, Machine.MachineRuntime>`.
