import type { Commands, Machine } from "../../Machine.js"

/** Captured callbacks shared by definition construction and both planners. */
export type TransitionHandler<States extends Machine.StateSchemas, Context> = (
  context: Context,
  enqueue: Commands<any, any>
) => Machine.HandlerResult<States> | Machine.Declined

export type TransitionEvaluator<States extends Machine.StateSchemas, Context> = (
  context: Context,
  enqueue: Commands<any, any>
) => {
  readonly result: Machine.HandlerResult<States> | Machine.Declined
  readonly branchIndex: number
  readonly branchKey: string | undefined
}

export type EventTransition<States extends Machine.StateSchemas, Context> =
  | TransitionHandler<States, Context>
  | {
    readonly reenter?: boolean
    readonly declinable?: boolean
    readonly targets?: ReadonlyArray<string>
    readonly transition: TransitionHandler<States, Context>
    readonly evaluate?: TransitionEvaluator<States, Context>
  }
