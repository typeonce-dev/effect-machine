## Run a machine on Effect Cluster

`ClusterMachine` from `@typeonce/effect-machine/cluster` runs a machine as a
persisted Cluster entity. It takes the same machine that `LocalMachine` runs.
Nothing about how the machine is written changes.

### Choose a host

| Host             | Where the machine lives                       | What survives a crash                    |
| ---------------- | --------------------------------------------- | ---------------------------------------- |
| `LocalMachine`   | in memory, owned by a `Scope`                 | nothing, unless you encode and resume it |
| `AtomMachine`    | in memory, owned by an `AtomRegistry`         | nothing                                  |
| `ClusterMachine` | one entity per id, on any runner of a Cluster | every committed step, from `Storage`     |

Use `ClusterMachine` when a machine must outlive the process that started it,
be addressed by id from anywhere, or wait on timers longer than a process
lives. Effect Cluster owns identity, placement, routing, and delivery.
`ClusterMachine` owns only the step: it applies one input at a time and commits
the result to `Storage`.

`ClusterMachine` needs `effect` 4.1.5 or later. Earlier versions answer the
keep-alive request of an entity after about ten minutes, so a machine whose
work runs or whose timer waits longer would not come up again after a crash.

### Make an adapter

```ts
import { Machine } from "@typeonce/effect-machine"
import { ClusterMachine, SqlMachineStorage } from "@typeonce/effect-machine/cluster"
import { Layer } from "effect"
import { SqlMessageStorage } from "effect/cluster"

const Invoice = ClusterMachine.make("Invoice", invoiceMachine, { version: "1" })

// Provide with a Cluster runner layer and an `SqlClient`.
const InvoiceLive = Invoice.toLayer().pipe(
  Layer.provide(Layer.mergeAll(SqlMessageStorage.layer, SqlMachineStorage.layer))
)
```

`version` is stored with every checkpoint. A checkpoint written by another
definition id or version is refused, so change it together with a migration of
the stored checkpoints.

State values, completion outputs, and public input events must have JSON
encoded forms. A schema that does not is a compile error that names the
offending states and events.

### What runs, and how often

Each live entity keeps one machine in memory and applies requests, the ends
of invoked effects, and timers one at a time. `Storage` is the truth and
memory is a cache: an entity that comes up anywhere continues from its last
checkpoint.

Invoked effects run at least once. Work starts once the step that entered its
state is stored, and runs again after a crash, a move to another runner, or a
restart, with `Machine.InitialEvent` as the event of its input mapper. Two
copies can briefly run at the same time while a shard moves. Exactly one result
is applied, and results are not stored. Make every invoked effect safe to
repeat, for example with an idempotency key from the state.

Work that ends in a way the model does not handle fails the machine, as it
does locally. The failure is stored as text with the last state, the
snapshot reads `failed`, and every later request is rejected as
`MachineFailed`. There is no hidden retry: a model that recovers declares
`onFailure`. A failure of storage or of Cluster itself never fails the
machine; it is retried.

### Timers

A timer is stored as the time at which it is due, in the checkpoint of the step
that enters its state. An entity that comes up again waits only for the time
that remains, and completes a timer that is already due at once. A timer up to
`DurableClock.InMemoryThreshold` (one minute by default) keeps its entity in
memory. A longer one is saved as a delayed Cluster message, in the same
transaction, so the entity may leave memory and is brought back when the timer
is due, up to `entityMessagePollInterval` late.

This differs from `LocalMachine.resume`, which starts a timer's full duration
again.

### Children and messages between machines

A child machine invoked by a state runs as an entity of its own, of type
`Type/childId` and id `entityId/childId/revision`, and starts and stops with
the stored state. `onDone`, `onFailure`, and `onSnapshot` work as they do
locally. A failure of a child fails its parent, even with `onFailure`, because
the failure is stored as text.

`adapter.target(id)` names another Cluster machine. `enqueue.sendTo` with a
target or with the descriptor of an invoked child saves the event with the
checkpoint of the step, so it is sent if and only if the step is stored, and
applied once. Work sends with `Machine.sendTo` and stops a child with
`Machine.stopChild`, given the child's descriptor.

### What is refused, and why

These do not compile with `ClusterMachine.make`. The error names the property
`~effect/cluster/ClusterMachine/UnsupportedProcessLocal` and lists what to replace:

- a state that invokes a Stream or a `Logic`;
- work that requires `Machine.MachineRuntime`, such as `Machine.spawn`, or
  `Machine.sendTo` and `Machine.stopChild` with a child address.

A checkpoint holds the state of a machine, and after a crash its work runs
again from the start. An Effect or a timer ends with one outcome, so running it
again changes nothing that was applied. A Stream ends after many elements, and
how far it got lives only in memory; a `Logic` has a state and a mailbox of its
own. Both would be lost. Model a source of many events as a child machine,
whose every step is stored, or as an Effect that ends with one result and a
state that is entered again for the next one.

### Talk to a machine from outside

```ts
const program = Effect.gen(function*() {
  const client = (yield* Invoice.client)("invoice-1")
  yield* client.send(Events.Send({ invoiceId: "inv-1" }))
  const latest = yield* client.snapshot // Option of the last committed checkpoint
  const receipt = yield* client.join // waits for the output, or fails with MachineFailedError
})
```

`send` decodes the event as a local reference does and waits until the step is
committed. An event the machine refuses fails with `Rejected` and its reason.
Failures of Cluster itself are `ClientError`s; a request that ended in one may
still have been delivered, and is applied at most once when sent again.

`snapshot`, `changes`, and `join` read `Storage`, never the entity, so they
work from any process that reaches the store and never wake the entity. A
client is a remote view, narrower than a `MachineRef`: it sees committed
checkpoints only, `changes` polls every `readInterval` (one second by default)
and may skip checkpoints in between, a failure is text rather than a `Cause`,
and nothing is read before the first event is committed.

### Storage

`ClusterMachine.Storage` holds one checkpoint per entity and the ids of the
requests it committed. `SqlMachineStorage` implements it for PostgreSQL and
SQLite. Use it over the same `SqlClient` as `SqlMessageStorage`, so a
checkpoint, the events it sends, and the reply commit in one transaction. Its
`layer` runs migrations first; use `layerMigrations` in a deploy step and
`layerStorage` at runtime to run them with another connection.
`ClusterMachine.layerMemory` is for tests and is not durable.

To write a store of your own, run `ClusterMachine.checkStorage` against it in
your tests, with the `withTransaction` of its `MessageStorage`. It fails with
the first part of the contract the store breaks.

### Run in a Web Worker or over RPC

`ClusterMachine` and `SqlMachineStorage` have no Node.js dependencies, so a
single-node Cluster can run inside a Web Worker or `SharedWorker` with
`SingleRunner.layer` and a browser SQL client such as `@effect/sql-sqlite-wasm`
or `@effect/sql-pglite`.

When the runner and its database live in another thread or process, callers do
not have direct access to `Sharding` or `ClusterMachine.Storage`.
`ClusterMachineProxy` from `@typeonce/effect-machine/cluster` exposes `send`,
`snapshot`, `changes`, and `join` over any `effect/rpc` transport (Web Workers,
`SharedWorker`, Node worker threads, WebSockets, or HTTP):

```ts
// Inside the Web Worker: serve one machine over RpcServer.Protocol
const WorkerLive = ClusterMachineProxy.toLayer(Invoice).pipe(
  Layer.provide(Invoice.toLayer()),
  Layer.provide(ClusterLive),
  Layer.provide(RpcServer.layerProtocolWorkerRunner)
)

// On the main thread: zero Sharding, zero Storage, zero SQL
const program = Effect.gen(function*() {
  const client = (yield* ClusterMachineProxy.client(Invoice))("invoice-1")
  yield* client.send(Events.Send({ invoiceId: "inv-1" }))
  const latest = yield* client.snapshot
  const receipt = yield* client.join
})
```

To host several machines on one worker or server, merge their groups with
`ClusterMachineProxy.toRpcGroup(A).merge(ClusterMachineProxy.toRpcGroup(B))` and
provide each with `ClusterMachineProxy.layerHandlers`. When using
`RpcClient.layerProtocolWorker` with `size: 1`, set `concurrency` above `1` (for
example `{ size: 1, concurrency: 100 }`) so streaming `changes` or `join` calls
do not block concurrent `send` calls.
