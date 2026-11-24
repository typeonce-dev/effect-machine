import type { Expectation } from "./scenario.js"

interface Entry {
  /** The scenario in which hosts differ. */
  readonly scenario: string

  /** The hosts that all differ in this same way. */
  readonly hosts: ReadonlyArray<string>

  /** What these hosts do instead of the reference. */
  readonly differs: string

  /**
   * What these hosts must do, by the name of the step in which they differ. The
   * parts that are left out are those of the scenario.
   */
  readonly steps: Readonly<Record<string, Expectation>>
}

/** A difference that is intended, and that users are told about. */
export interface DeliberateDifference extends Entry {
  readonly kind: "Deliberate"

  /** Why these hosts differ. */
  readonly because: string

  /** A sentence of the public documentation that says so. */
  readonly documentedIn: { readonly file: string; readonly text: string }
}

/**
 * A difference that no documentation mentions, or a bug: known, reported, and not
 * decided yet. It ends as a change of a host, or as a deliberate difference.
 */
export interface OpenDifference extends Entry {
  readonly kind: "Open"

  /** What shows the difference, and where it comes from. */
  readonly evidence: string
}

export type Difference = DeliberateDifference | OpenDifference
