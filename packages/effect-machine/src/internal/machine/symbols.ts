import type { Logic } from "../../Machine.js"

/** @internal */
export const InitialEventTypeId: unique symbol = Symbol("effect/Machine/InitialEvent")

/** @internal */
export const SnapshotBuilderStateTypeId: unique symbol = Symbol("effect/Machine/SnapshotBuilderState")

/** @internal Returns process logic for a child descriptor and optional input. */
export const ChildMachineLogicTypeId: unique symbol = Symbol("effect/Machine/ChildMachineLogic")

/**
 * @internal Runtime slot of a child machine descriptor. The public
 * `ChildMachine` declares this key as a type-level brand only, so descriptors
 * cross that erased boundary where they are built and where their logic is read.
 */
export interface ChildMachineLogicSlot {
  readonly [ChildMachineLogicTypeId]: (input?: unknown) => Logic<any, any, any, any, any, any>
}
