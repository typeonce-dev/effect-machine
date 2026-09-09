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
  const hasObjectTransitions = typeof Machine.targets === "function"
  const transitionDefinition = Symbol("benchmark transition")
  const invocationDefinition = Symbol("benchmark invocation")
  const hasRoot = typeof Machine.eventsFromSchemas === "function"
  const snapshot = (value) => hasRoot ? value.state : value
  const hasStaticTransitions = typeof Machine.transition === "function" && Machine.transition.length === 1
  const hasFluentTransitions = !hasStaticTransitions && typeof Machine.invokeMachine !== "function"
  const hasFluentInvocations = typeof Machine.invoke !== "function" && typeof Machine.invokeMachine !== "function"
  const hasValueSelectors = hasFluentTransitions && Machine.targetless === undefined
  const targetless = ({ target }) => typeof target.none === "function" ? target.none() : undefined
  const selectInstruction = (selection) => typeof selection === "function" ? selection() : selection

  const fluentTransition = (definition) => (to) => {
    const selection = selectInstruction(definition.target(hasRoot ? { ...to, full: to.branch } : to))
    const reentered = definition.reenter === true && typeof selection.reenter === "function" ? selection.reenter() : undefined
    const constructor = reentered ?? selection
    if (definition.from !== undefined && typeof constructor.from === "function" && (definition.reenter !== true || reentered !== undefined)) {
      return constructor.from(definition.from)
    }
    const resolve = definition.from === undefined ? definition.resolve : (context) => context.target.from(definition.from(context))
    if (resolve !== undefined) {
      const chainable = reentered !== undefined && typeof reentered.resolve === "function"
      return (chainable ? reentered : selection).resolve(resolve, {
        ...(definition.reenter === true && !chainable ? { reenter: true } : {}),
        ...(definition.declinable === true ? { declinable: true } : {})
      })
    }
    return reentered ?? selection
  }

  const fluentInitial = (definition) => (to) => {
    const selection = selectInstruction(definition.target(to))
    return definition.resolve === undefined ? selection : selection.resolve(definition.resolve)
  }

  const objectInitial = (definition) => ({
    ...definition,
    target: (to) => selectInstruction(definition.target(to))
  })

  const objectTransition = ({ from, ...definition }) => ({
    ...definition,
    ...(from === undefined ? {} : { resolve: (context) => context.target.from(from(context)) }),
    target: (to) => selectInstruction(definition.target(to))
  })

  return {
    snapshot,
    make: (config) => {
      if (!hasRoot) return Machine.make(config)
      const { states: root, initial, ...rest } = config
      const definition = initial.benchmarkInitial
      // Target selection belongs to definition time in both public APIs.
      // Only the selected value constructor runs each time a machine starts.
      const selectors = Object.fromEntries(Object.keys(root.node.states).map((key) => {
        const selected = () => key
        selected.initial = key
        return [key, selected]
      }))
      const initialKey = selectInstruction(definition.target(selectors))
      const initialConfiguration = (root) => root.resolve((context) =>
        context.target.from((tree) => {
          const target = tree[initialKey]
          return definition.resolve === undefined ? target.from() : definition.resolve({ ...context, target })
        }))
      if (!hasObjectTransitions) {
        const machine = Machine.make({ ...rest, root, initialConfiguration })
        return { handle: (states) => machine.handle({ states }) }
      }
      const targets = Machine.targets(root)
      const referenceSelectors = (refs) => Object.fromEntries(Object.entries(refs).map(([key, ref]) => {
        const selected = () => ref
        Object.assign(selected, referenceSelectors(ref))
        return [key, selected]
      }))
      const selectorsForRoot = referenceSelectors(targets.root)
      const children = {}
      const transition = (value, siblings) => {
        const definition = value?.[transitionDefinition]
        if (definition === undefined) return value
        const target = selectInstruction(definition.target({ full: selectorsForRoot, branch: selectorsForRoot, local: siblings }))
        return {
          target,
          ...(definition.from !== undefined ? { from: definition.from } : definition.resolve === undefined ? {} : { from: (context) => definition.resolve({ ...context, target: { from: (value) => value } }) }),
          ...(definition.reenter === true ? { reenter: true } : {})
        }
      }
      const walk = (nodes, refs) => Object.fromEntries(Object.entries(nodes).map(([key, node]) => {
        const siblings = referenceSelectors(refs)
        const result = { ...node }
        if (node.on !== undefined) result.on = Object.fromEntries(Object.entries(node.on).map(([event, value]) => [event, transition(value, siblings)]))
        if (node.states !== undefined) result.states = walk(node.states, refs[key])
        if (node.invoke !== undefined) {
          const config = node.invoke[invocationDefinition]
          if (config === undefined) throw new Error("Unsupported benchmark invocation")
          const src = `child${Object.keys(children).length}`
          children[src] = config.child
          const { child, ...options } = config
          result.invoke = { src, ...options }
        }
        return [key, result]
      }))
      return { handle: (states) => {
        const handlers = walk(states, targets.root)
        return Machine.make({ ...rest, root, initialConfiguration, children }).handle({ states: handlers })
      } }

    },
    states: (definitions) =>
      hasRoot ? { states: Machine.state({ initial: Object.keys(definitions)[0], states: definitions }) } : typeof Machine.states === "function" ? Machine.states(definitions) : Machine.defineStates(definitions),
    events: hasRoot ? (...schemas) => Machine.eventsFromSchemas(...schemas) : typeof Machine.event === "function"
      ? (...schemas) => schemas
      : (...schemas) => Machine.events(...schemas),
    initial: (definition, legacy) => hasRoot ? { benchmarkInitial: definition } : hasValueSelectors
      ? fluentInitial(definition)
      : hasStaticTransitions || hasFluentTransitions
      ? objectInitial(definition)
      : legacy,
    transition: (definition, legacy) => hasObjectTransitions ? { [transitionDefinition]: definition } : hasStaticTransitions
      ? Machine.transition(objectTransition(definition))
      : hasFluentTransitions
      ? fluentTransition(definition)
      : legacy,
    targetless: hasObjectTransitions ? { none: true } : hasValueSelectors
      ? (to) => to.none
      : hasStaticTransitions || hasFluentTransitions
      ? { target: Machine.targetless }
      : targetless,
    invokeChild: hasObjectTransitions ? (config) => ({ [invocationDefinition]: config }) : hasFluentInvocations
      ? (config) => (from) => {
        let invoked = config.input === undefined
          ? from.child(config.child)
          : from.child(config.child, { input: config.input })
        if (config.onSnapshot !== undefined) invoked = invoked.onSnapshot(config.onSnapshot)
        if (config.onDone !== undefined) invoked = invoked.onDone(config.onDone)
        if (config.onFailure !== undefined) invoked = invoked.onFailure(config.onFailure)
        return invoked
      }
      : typeof Machine.invokeMachine === "function"
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
