---
"@typeonce/effect-machine": minor
---

Add `ClusterMachineProxy` to `@typeonce/effect-machine/cluster` to expose `ClusterMachine` adapters over any `effect/rpc` transport, including Web Workers, `SharedWorker`, Node worker threads, WebSockets, and HTTP.

When a Cluster runner and its SQL database live in another thread or process — such as a browser Web Worker running `SingleRunner` with `SqlMachineStorage` — callers on the main thread have neither `Sharding` nor `ClusterMachine.Storage`. `ClusterMachineProxy` derives prefixed `send`, `snapshot`, and `changes` RPCs and gives callers a typed `ClusterMachineProxy.Client` with `send`, `snapshot`, `changes`, and `join`:

```ts
import { ClusterMachineProxy } from "@typeonce/effect-machine/cluster"
import { Effect, Layer } from "effect"
import { RpcServer } from "effect/rpc"

// Inside the worker or RPC server:
const ServerLive = ClusterMachineProxy.toLayer(Order).pipe(
  Layer.provide(Order.toLayer()),
  Layer.provide(ClusterLive),
  Layer.provide(RpcServer.layerProtocolWorkerRunner)
)

// On the main thread or remote client (requires only RpcClient.Protocol and Scope):
const program = Effect.gen(function*() {
  const client = (yield* ClusterMachineProxy.client(Order))("order-1")
  yield* client.send(Events.Pay({ amount: 50 }))
  const snapshot = yield* client.snapshot
})
```

Compose multiple Cluster machines onto one worker or server with `ClusterMachineProxy.toRpcGroup(A).merge(ClusterMachineProxy.toRpcGroup(B))` and `ClusterMachineProxy.layerHandlers`.
