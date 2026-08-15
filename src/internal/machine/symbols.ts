/** @internal */
export const InitialEventTypeId: unique symbol = Symbol("effect/Machine/InitialEvent")

/** @internal Converts a child machine descriptor to process logic at entry time. */
export const ChildMachineLogicTypeId: unique symbol = Symbol("effect/Machine/ChildMachineLogic")
