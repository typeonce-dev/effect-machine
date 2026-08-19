/**
 * Adapts the Effect Machine public API used by the runtime benchmark fixture.
 *
 * Pull request benchmarks execute the head revision's fixture against both the
 * base and head packages. Public API migrations therefore belong at this one
 * capability boundary instead of leaking version checks into benchmark cases.
 */
export const makeEffectMachineBenchmarkApi = (Machine) => {
  // The legacy process constructor takes `(initial, transition)`. The static
  // definition constructor is deliberately unary and returns its config.
  const hasStaticTransitions = typeof Machine.transition === "function" && Machine.transition.length === 1
  const hasFluentTransitions = !hasStaticTransitions && Machine.targetless?.["~effect/Machine/TargetlessSelector"] === true
  const targetless = ({ target }) => typeof target.none === "function" ? target.none() : undefined

  const fluentTransition = (definition) => (to) => {
    const selection = definition.target(to)
    if (definition.resolve !== undefined) {
      return selection.resolve(definition.resolve, {
        ...(definition.reenter === true ? { reenter: true } : {}),
        ...(definition.declinable === true ? { declinable: true } : {})
      })
    }
    return definition.reenter === true ? selection.reenter() : selection
  }

  return {
    states: (definitions) =>
      typeof Machine.states === "function" ? Machine.states(definitions) : Machine.defineStates(definitions),
    events: typeof Machine.event === "function"
      ? (...schemas) => schemas
      : (...schemas) => Machine.events(...schemas),
    initial: (definition, legacy) => hasStaticTransitions || hasFluentTransitions ? definition : legacy,
    transition: (definition, legacy) => hasStaticTransitions
      ? Machine.transition(definition)
      : hasFluentTransitions
      ? fluentTransition(definition)
      : legacy,
    targetless: hasStaticTransitions || hasFluentTransitions
      ? { target: Machine.targetless }
      : targetless,
    invokeChild: typeof Machine.invokeMachine === "function"
      ? ({ onSnapshot, onFailure, ...config }) => {
        if (onFailure !== undefined) {
          throw new Error("The legacy child invocation API cannot handle failures as parent transitions")
        }

        return Machine.invokeMachine({
          ...config,
          ...(onSnapshot === undefined ? {} : { snapshot: onSnapshot })
        })
      }
      : (config) => Machine.invoke(config)
  }
}
