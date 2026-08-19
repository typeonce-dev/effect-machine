---
"@typeonce/effect-machine": minor
---

Make `Machine.encodeSnapshot` return a canonical JSON representation or fail
with `MachineSchemaEncodeError`. Encoded state values, completion outputs, and
history values are now typed as `Schema.Json`; rich schema values use their
canonical JSON codecs, while cycles and other non-JSON values fail at the
machine boundary instead of causing a later serialization crash.
Declared `Schema.Void` and `Schema.Undefined` completion outputs now use their
canonical `null` encoding; an omitted output is reserved for final states that
do not declare an output schema.

`ClusterMachine.make` now requires JSON-encoded state, completion-output, and
public input-event schemas. Keep process-local capabilities in services,
adapters, or internal events, and give transported values an explicit JSON
codec. Cluster snapshot encoding failures are reported as
`SnapshotEncodeFailure` without advancing the checkpoint.

`MachineTest.observedGraph` continues to support process-local state. Its node
`encoded` field is now optional: portable snapshots retain their canonical JSON
form, while non-portable snapshots use local structural identity and omit it.
Snapshot encoding failures no longer appear in the operation's error channel.
