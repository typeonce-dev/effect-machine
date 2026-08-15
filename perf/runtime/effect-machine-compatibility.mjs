/**
 * Adapts the Effect Machine public API used by the runtime benchmark fixture.
 *
 * Pull request benchmarks execute the head revision's fixture against both the
 * base and head packages. Public API migrations therefore belong at this one
 * capability boundary instead of leaking version checks into benchmark cases.
 */
export const makeEffectMachineBenchmarkApi = (Machine) => ({
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
})
