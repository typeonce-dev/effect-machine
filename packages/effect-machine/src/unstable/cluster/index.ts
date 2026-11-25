export * as ClusterMachine from "./ClusterMachine.js"

/**
 * Exposes `ClusterMachine` adapters over `effect/rpc` transports, including Web
 * Workers, `SharedWorker`, WebSockets, and HTTP.
 *
 * @since 0.48.0
 */
export * as ClusterMachineProxy from "./ClusterMachineProxy.js"

/**
 * Stores the checkpoints of Cluster machines in a SQL database.
 *
 * @since 0.48.0
 */
export * as SqlMachineStorage from "./SqlMachineStorage.js"
