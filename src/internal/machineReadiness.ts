import type * as Machine from "../Machine.js"

/** Canonical proof required before a machine can be planned or executed. */
export type EnsureExecutable<
  States extends Machine.Machine.StateSchemas,
  UnhandledStates extends Machine.Machine.StateIdentifier<States>,
  OutputStates extends Machine.Machine.StateIdentifier<States>
> =
  & Machine.Machine.EnsureOutputImplementations<States, OutputStates>
  & Machine.Machine.EnsureHistoryImplementations<States, UnhandledStates>
