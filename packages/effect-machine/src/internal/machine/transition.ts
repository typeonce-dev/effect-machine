import type { Enqueue, Machine } from "../../Machine.js"

/** Captured callbacks shared by definition construction and both planners. */
export type TransitionHandler<States extends Machine.StateSchemas, E, R, Context> = (
  context: Context,
  enqueue: Enqueue<any, any>
) => Machine.HandlerResult<States, E, R> | Machine.Declined

export type TransitionEvaluator<States extends Machine.StateSchemas, E, R, Context> = (
  context: Context,
  enqueue: Enqueue<any, any>
) => {
  readonly result: Machine.HandlerResult<States, E, R> | Machine.Declined
  readonly branchIndex: number
  readonly branchKey: string | undefined
}

export type EventTransition<States extends Machine.StateSchemas, E, R, Context> =
  | TransitionHandler<States, E, R, Context>
  | {
    readonly reenter?: boolean
    readonly declinable?: boolean
    readonly targets?: ReadonlyArray<string>
    readonly transition: TransitionHandler<States, E, R, Context>
    readonly evaluate?: TransitionEvaluator<States, E, R, Context>
  }
