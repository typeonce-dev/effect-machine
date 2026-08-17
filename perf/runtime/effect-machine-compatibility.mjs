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
  const targetless = ({ target }) => typeof target.none === "function" ? target.none() : undefined

  return {
    events: typeof Machine.event === "function"
      ? (...schemas) => schemas
      : (...schemas) => Machine.events(...schemas),
    initial: (definition, legacy) => hasStaticTransitions ? definition : legacy,
    transition: (definition, legacy) => hasStaticTransitions ? Machine.transition(definition) : legacy,
    targetless: hasStaticTransitions
      ? Machine.transition({ target: (to) => to.none(), resolve: () => undefined })
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
