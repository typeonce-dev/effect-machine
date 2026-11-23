/**
 * Generation bookkeeping for the invoking states of one machine instance.
 *
 * @since 0.47.2
 */

import type * as InvocationEvent from "./invocationEvent.js"

/**
 * The current generation of each active invoking state of one machine instance.
 *
 * A host owns one instance per hosted machine instance and must:
 *
 * - begin a generation each time it starts the invocations of an entered state,
 *   once per group returned by `InvocationResolution.resolve`;
 * - keep it current while the state stays active, including after its
 *   invocations have finished;
 * - retire it when the state exits, no later than the invocations it owns are
 *   stopped, and retire every generation when the machine stops.
 *
 * Retiring is what makes late outcomes harmless: every `InvocationEvent`
 * carries its generation, so the planner ignores one that was queued before its
 * state exited, even after the same path and id are entered again.
 *
 * @internal
 */
export class InvocationGenerations {
  // Most configurations have one invoking path, held inline; further paths use
  // the map. Entries are removed when their state exits, so neither outgrows
  // the active configuration.
  private generationPath: string | undefined
  private generation: InvocationEvent.Generation | undefined
  private generations: Map<string, InvocationEvent.Generation> | undefined

  /** Begins the generation of an entered path and retires the one it replaces. */
  beginGeneration(path: string): InvocationEvent.Generation {
    this.retireGeneration(path)
    const generation: InvocationEvent.Generation = { current: true }
    if (this.generationPath === undefined) {
      this.generationPath = path
      this.generation = generation
    } else {
      ;(this.generations ??= new Map()).set(path, generation)
    }
    return generation
  }

  /** Retires the generations of exited paths; paths without one are ignored. */
  retireGenerations(paths: ReadonlyArray<string>): void {
    if (this.generation !== undefined || (this.generations !== undefined && this.generations.size > 0)) {
      for (const path of paths) this.retireGeneration(path)
    }
  }

  /** Retires every generation when the machine stops. */
  retireAllGenerations(): void {
    if (this.generation !== undefined) {
      this.generation.current = false
      this.generationPath = undefined
      this.generation = undefined
    }
    const generations = this.generations
    if (generations !== undefined && generations.size > 0) {
      for (const generation of generations.values()) generation.current = false
      generations.clear()
    }
  }

  private retireGeneration(path: string): void {
    const inline = this.generation
    if (inline !== undefined && this.generationPath === path) {
      inline.current = false
      this.generationPath = undefined
      this.generation = undefined
      return
    }
    const generations = this.generations
    const generation = generations?.get(path)
    if (generations !== undefined && generation !== undefined) {
      generation.current = false
      generations.delete(path)
    }
  }
}
