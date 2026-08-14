/**
 * Internal encoded snapshot serialization.
 *
 * @since 0.4.0
 */

import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { Machine } from "../../Machine.js"
import {
  type ActiveConfiguration,
  compareDocumentOrder,
  configurationFromSnapshot,
  getActiveChildPath,
  getActiveValue,
  getPathToRoot,
  type HistoryRecord,
  isActiveFinalNode,
  isPathInSubtree,
  normalizeConfigurationEffect,
  snapshotFromConfiguration,
  validateHistoryRecordControl
} from "./configuration.js"
import { MachineSchemaDecodeError, MachineSchemaEncodeError } from "./errors.js"
import { decodeBoundary } from "./protocol.js"
import { getNode, getStateNodeSchema } from "./topology.js"

const EncodedSnapshotSchema = Schema.Struct({
  _tag: Schema.Literal("MachineSnapshot"),
  active: Schema.Array(Schema.Struct({
    path: Schema.String,
    value: Schema.optional(Schema.Unknown)
  })),
  completed: Schema.optional(Schema.Array(Schema.Struct({
    path: Schema.String,
    output: Schema.optional(Schema.Unknown)
  }))),
  history: Schema.optional(Schema.Record(
    Schema.String,
    Schema.Struct({
      mode: Schema.Literals(["shallow", "deep"]),
      active: Schema.Array(Schema.String),
      values: Schema.Record(Schema.String, Schema.Unknown)
    })
  ))
})

const encodeBoundary = (
  machine: Machine.Any,
  schema: Schema.Top,
  value: unknown,
  options: {
    readonly boundary: "state" | "output" | "history"
    readonly state: string
  }
): Effect.Effect<unknown, MachineSchemaEncodeError, unknown> =>
  Schema.encodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((cause) =>
      new MachineSchemaEncodeError({
        machineId: machine.id,
        boundary: options.boundary,
        state: options.state,
        cause
      })
    )
  )

const decodeEncodedBoundary = (
  machine: Machine.Any,
  schema: Schema.Top,
  value: unknown,
  options: {
    readonly boundary: "state" | "output" | "history"
    readonly state: string
  }
): Effect.Effect<unknown, MachineSchemaDecodeError, unknown> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((cause) =>
      new MachineSchemaDecodeError({
        machineId: machine.id,
        boundary: options.boundary,
        state: options.state,
        cause
      })
    )
  )

const getCompletionSchema = (
  machine: Machine.Any,
  configuration: ActiveConfiguration,
  path: string
): Schema.Top => {
  const node = getNode(machine, path)
  if (node.type === "compound") {
    const child = getActiveChildPath(machine, configuration, path)
    if (child === undefined) {
      throw new Error(`Machine expected completed state "${path}" to have an active child`)
    }
    return getCompletionSchema(machine, configuration, child)
  }
  return node.output ?? Schema.Void
}

/** Defensively validates and normalizes an in-memory logical snapshot. Unlike
 * the transport decoder this consumes decoded schema values. */
export const normalizeSnapshotEffect = <const States extends Machine.StateSchemas>(
  machine: Machine.Any,
  snapshot: Machine.Snapshot<States>
): Effect.Effect<Machine.Snapshot<States>, MachineSchemaDecodeError> =>
  Effect.gen(function*() {
    const configuration = yield* normalizeConfigurationEffect(machine, snapshot)
    const outputs = new Map<string, unknown>()
    const completionPaths = new Set<string>()
    const completions = snapshot.completed ?? []
    if (!Array.isArray(completions)) {
      throw new Error("Machine snapshot completion metadata must be an array")
    }
    for (const completion of completions) {
      if (
        typeof completion !== "object" || completion === null ||
        typeof (completion as { readonly path?: unknown }).path !== "string"
      ) {
        throw new Error("Machine snapshot contains malformed completion metadata")
      }
      const path = completion.path
      if (completionPaths.has(path)) {
        throw new Error(`Machine snapshot contains duplicate completion "${path}"`)
      }
      if (!configuration.active.has(path) || !isActiveFinalNode(machine, configuration, path)) {
        throw new Error(`Machine snapshot contains invalid completion "${path}"`)
      }
      completionPaths.add(path)
      outputs.set(
        path,
        yield* decodeBoundary(machine, getCompletionSchema(machine, configuration, path), completion.output, {
          boundary: "output",
          state: path
        })
      )
    }
    return snapshotFromConfiguration<States>(machine, { ...configuration, outputs })
  }).pipe(Effect.catchCause((cause) => failDecodeCause(machine, cause)))

const validateEncodedConfiguration = (
  machine: Machine.Any,
  configuration: ActiveConfiguration
): Machine.Snapshot<any> => {
  const snapshot = snapshotFromConfiguration(machine, configuration)
  const normalized = configurationFromSnapshot(machine, snapshot)
  if (
    normalized.active.size !== configuration.active.size ||
    Array.from(configuration.active).some((path) => !normalized.active.has(path))
  ) {
    throw new Error("Machine encoded snapshot contains states outside its active configuration")
  }
  return snapshot
}

const failEncodeCause = (
  machine: Machine.Any,
  cause: Cause.Cause<unknown>
): Effect.Effect<never, MachineSchemaEncodeError> => {
  const error = Cause.findErrorOption(cause)
  return Option.isSome(error) && error.value instanceof MachineSchemaEncodeError
    ? Effect.fail(error.value)
    : Effect.fail(
      new MachineSchemaEncodeError({
        machineId: machine.id,
        boundary: "configuration",
        cause
      })
    )
}

const failDecodeCause = (
  machine: Machine.Any,
  cause: Cause.Cause<unknown>
): Effect.Effect<never, MachineSchemaDecodeError> => {
  const error = Cause.findErrorOption(cause)
  return Option.isSome(error) && error.value instanceof MachineSchemaDecodeError
    ? Effect.fail(error.value)
    : Effect.fail(
      new MachineSchemaDecodeError({
        machineId: machine.id,
        boundary: "configuration",
        cause
      })
    )
}

export const encodeSnapshot = (
  machine: Machine.Any,
  snapshot: Machine.Snapshot<any>
): Effect.Effect<Machine.EncodedSnapshot, MachineSchemaEncodeError, unknown> =>
  Effect.gen(function*() {
    const configuration = yield* normalizeConfigurationEffect(machine, snapshot).pipe(
      Effect.mapError((error) =>
        new MachineSchemaEncodeError({
          machineId: machine.id,
          boundary: error.boundary === "state" || error.boundary === "history" ? error.boundary : "configuration",
          ...(error.state === undefined ? {} : { state: error.state }),
          cause: error.cause
        })
      )
    )
    const completionPaths = new Set<string>()
    for (const completion of snapshot.completed ?? []) {
      if (completionPaths.has(completion.path)) {
        throw new Error(`Machine snapshot contains duplicate completion "${completion.path}"`)
      }
      if (!configuration.active.has(completion.path) || !isActiveFinalNode(machine, configuration, completion.path)) {
        throw new Error(`Machine snapshot contains invalid completion "${completion.path}"`)
      }
      completionPaths.add(completion.path)
    }
    const active: Array<Machine.EncodedSnapshotState> = []
    for (
      const path of Array.from(configuration.active).sort((left, right) => compareDocumentOrder(machine, left, right))
    ) {
      const node = getNode(machine, path)
      if (node.schema === undefined) {
        active.push({ path })
      } else {
        active.push({
          path,
          value: yield* encodeBoundary(machine, getStateNodeSchema(node), getActiveValue(configuration, path), {
            boundary: "state",
            state: path
          })
        })
      }
    }

    const completed: Array<Machine.EncodedSnapshotCompletion> = []
    for (
      const [path, output] of Array.from(configuration.outputs).sort(([left], [right]) =>
        compareDocumentOrder(machine, left, right)
      )
    ) {
      if (!configuration.active.has(path) || !isActiveFinalNode(machine, configuration, path)) {
        throw new Error(`Machine encoded snapshot contains invalid completion "${path}"`)
      }
      const encodedOutput = yield* encodeBoundary(
        machine,
        getCompletionSchema(machine, configuration, path),
        output,
        {
          boundary: "output",
          state: path
        }
      )
      completed.push({
        path,
        ...(encodedOutput === undefined ? {} : { output: encodedOutput })
      })
    }

    const history: Record<string, Machine.EncodedSnapshotHistoryEntry> = {}
    for (
      const [historyPath, record] of Array.from(configuration.history).sort(([left], [right]) =>
        left.localeCompare(right)
      )
    ) {
      const historyNode = machine.stateNodes.byPath.get(historyPath)
      if (
        historyNode === undefined || historyNode.type !== "history" || historyNode.parent !== record.parent ||
        historyNode.history !== record.mode
      ) {
        return yield* Effect.fail(
          new MachineSchemaEncodeError({
            machineId: machine.id,
            boundary: "history",
            state: historyPath,
            cause: Cause.die(new Error(`Machine snapshot contains invalid history record "${historyPath}"`))
          })
        )
      }
      try {
        validateHistoryRecordControl(machine, record)
      } catch (cause) {
        return yield* Effect.fail(
          new MachineSchemaEncodeError({
            machineId: machine.id,
            boundary: "history",
            state: historyPath,
            cause: Cause.die(cause)
          })
        )
      }
      const encodedValues: Record<string, unknown> = {}
      for (const path of record.active) {
        const stateNode = machine.stateNodes.byPath.get(path)
        if (
          stateNode === undefined || stateNode.type === "history" || stateNode.type === "choice" ||
          !(isPathInSubtree(path, record.parent) || getPathToRoot(machine, record.parent).includes(path))
        ) {
          return yield* Effect.fail(
            new MachineSchemaEncodeError({
              machineId: machine.id,
              boundary: "history",
              state: path,
              cause: Cause.die(new Error(`Machine snapshot contains invalid remembered state "${path}"`))
            })
          )
        }
        if (stateNode.schema === undefined) {
          if (record.values.has(path)) {
            throw new Error(`Machine history record contains a value for structural state "${path}"`)
          }
        } else {
          if (!record.values.has(path)) {
            throw new Error(`Machine history record omits value for "${path}"`)
          }
          encodedValues[path] = yield* encodeBoundary(
            machine,
            getStateNodeSchema(stateNode),
            record.values.get(path),
            { boundary: "history", state: path }
          )
        }
      }
      if (Object.keys(encodedValues).length !== record.values.size) {
        return yield* Effect.fail(
          new MachineSchemaEncodeError({
            machineId: machine.id,
            boundary: "history",
            state: historyPath,
            cause: Cause.die(new Error(`Machine history record "${historyPath}" contains values outside its paths`))
          })
        )
      }
      history[historyPath] = {
        mode: record.mode,
        active: Array.from(record.active).sort((left, right) => compareDocumentOrder(machine, left, right)),
        values: encodedValues
      }
    }

    return {
      _tag: "MachineSnapshot" as const,
      active,
      ...(completed.length === 0 ? {} : { completed }),
      ...(Object.keys(history).length === 0 ? {} : { history })
    }
  }).pipe(Effect.catchCause((cause) => failEncodeCause(machine, cause)))

export const decodeSnapshot = (
  machine: Machine.Any,
  encoded: unknown
): Effect.Effect<Machine.Snapshot<any>, MachineSchemaDecodeError, unknown> =>
  Effect.gen(function*() {
    const decoded = yield* Schema.decodeUnknownEffect(EncodedSnapshotSchema)(encoded).pipe(
      Effect.mapError((cause) =>
        new MachineSchemaDecodeError({
          machineId: machine.id,
          boundary: "configuration",
          cause
        })
      )
    )
    const active = new Set<string>()
    const values = new Map<string, unknown>()
    for (const entry of decoded.active) {
      if (active.has(entry.path)) {
        throw new Error(`Machine encoded snapshot contains duplicate state "${entry.path}"`)
      }
      const node = getNode(machine, entry.path)
      active.add(entry.path)
      const hasValue = Object.prototype.hasOwnProperty.call(entry, "value")
      if (node.schema === undefined) {
        if (hasValue) throw new Error(`Machine encoded snapshot contains a value for structural state "${entry.path}"`)
      } else {
        if (!hasValue) throw new Error(`Machine encoded snapshot omits value for state "${entry.path}"`)
        values.set(
          entry.path,
          yield* decodeEncodedBoundary(machine, getStateNodeSchema(node), entry.value, {
            boundary: "state",
            state: entry.path
          })
        )
      }
    }

    const history = new Map<string, HistoryRecord>()
    for (const [historyPath, encodedRecord] of Object.entries(decoded.history ?? {})) {
      const historyNode = machine.stateNodes.byPath.get(historyPath)
      if (
        historyNode === undefined || historyNode.type !== "history" || historyNode.parent === undefined ||
        historyNode.history !== encodedRecord.mode
      ) {
        return yield* Effect.fail(
          new MachineSchemaDecodeError({
            machineId: machine.id,
            boundary: "history",
            state: historyPath,
            cause: Cause.die(new Error(`Machine encoded snapshot contains invalid history record "${historyPath}"`))
          })
        )
      }
      const rememberedActive = new Set<string>()
      const rememberedValues = new Map<string, unknown>()
      for (const path of encodedRecord.active) {
        if (rememberedActive.has(path)) {
          return yield* Effect.fail(
            new MachineSchemaDecodeError({
              machineId: machine.id,
              boundary: "history",
              state: path,
              cause: Cause.die(new Error(`Machine encoded history contains duplicate state "${path}"`))
            })
          )
        }
        const stateNode = machine.stateNodes.byPath.get(path)
        if (
          stateNode === undefined || stateNode.type === "history" || stateNode.type === "choice" ||
          !(isPathInSubtree(path, historyNode.parent) || getPathToRoot(machine, historyNode.parent).includes(path))
        ) {
          return yield* Effect.fail(
            new MachineSchemaDecodeError({
              machineId: machine.id,
              boundary: "history",
              state: path,
              cause: Cause.die(new Error(`Machine encoded snapshot contains invalid remembered state "${path}"`))
            })
          )
        }
        rememberedActive.add(path)
        const hasValue = Object.prototype.hasOwnProperty.call(encodedRecord.values, path)
        if (stateNode.schema === undefined) {
          if (hasValue) {
            throw new Error(`Machine encoded history contains a value for structural state "${path}"`)
          }
        } else {
          if (!hasValue) throw new Error(`Machine encoded history omits value for state "${path}"`)
          rememberedValues.set(
            path,
            yield* decodeEncodedBoundary(machine, getStateNodeSchema(stateNode), encodedRecord.values[path], {
              boundary: "history",
              state: path
            })
          )
        }
      }
      if (Object.keys(encodedRecord.values).length !== rememberedValues.size) {
        return yield* Effect.fail(
          new MachineSchemaDecodeError({
            machineId: machine.id,
            boundary: "history",
            state: historyPath,
            cause: Cause.die(new Error(`Machine encoded history "${historyPath}" contains values outside its paths`))
          })
        )
      }
      if (!rememberedActive.has(historyNode.parent)) {
        return yield* Effect.fail(
          new MachineSchemaDecodeError({
            machineId: machine.id,
            boundary: "history",
            state: historyPath,
            cause: Cause.die(new Error(`Machine encoded history "${historyPath}" does not contain its parent state`))
          })
        )
      }
      const record: HistoryRecord = {
        mode: encodedRecord.mode,
        parent: historyNode.parent,
        active: rememberedActive,
        values: rememberedValues
      }
      try {
        validateHistoryRecordControl(machine, record)
      } catch (cause) {
        return yield* Effect.fail(
          new MachineSchemaDecodeError({
            machineId: machine.id,
            boundary: "history",
            state: historyPath,
            cause: Cause.die(cause)
          })
        )
      }
      history.set(historyPath, record)
    }

    const configuration: ActiveConfiguration = {
      active,
      values,
      outputs: new Map(),
      history
    }
    const snapshot = validateEncodedConfiguration(machine, configuration)
    const completions: Array<Machine.SnapshotCompletion> = []
    const completionPaths = new Set<string>()
    for (const completion of decoded.completed ?? []) {
      if (completionPaths.has(completion.path)) {
        throw new Error(`Machine encoded snapshot contains duplicate completion "${completion.path}"`)
      }
      if (!active.has(completion.path) || !isActiveFinalNode(machine, configuration, completion.path)) {
        throw new Error(`Machine encoded snapshot contains invalid completion "${completion.path}"`)
      }
      completionPaths.add(completion.path)
      completions.push({
        path: completion.path,
        output: yield* decodeEncodedBoundary(
          machine,
          getCompletionSchema(machine, configuration, completion.path),
          completion.output,
          {
            boundary: "output",
            state: completion.path
          }
        )
      })
    }
    if (completions.length > 0) {
      ;(snapshot as Machine.AtomicSnapshot<string, unknown> & {
        completed: ReadonlyArray<Machine.SnapshotCompletion>
      }).completed = completions
    }
    return snapshot
  }).pipe(Effect.catchCause((cause) => failDecodeCause(machine, cause)))
