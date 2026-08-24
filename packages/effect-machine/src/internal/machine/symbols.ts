/** @internal */
export const InitialEventTypeId: unique symbol = Symbol("effect/Machine/InitialEvent")

/** @internal */
export const SnapshotBuilderStateTypeId: unique symbol = Symbol("effect/Machine/SnapshotBuilderState")

/** @internal Returns process logic for a child descriptor and optional input. */
export const ChildMachineLogicTypeId: unique symbol = Symbol("effect/Machine/ChildMachineLogic")
