import { RuleTester } from "oxlint/plugins-dev"
import { describe, it } from "vitest"
import plugin from "../src/index.js"

RuleTester.describe = describe
RuleTester.it = it

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } }
})

const rule = plugin.rules["no-conflicting-invocation-identity"]

tester.run("no-conflicting-invocation-identity", rule, {
  valid: [
    `import { Machine } from "@typeonce/effect-machine"
Machine.make({ initial: (to) => to.Ready() }).handle({ Ready: { invoke: (from) => [
  from.effect("load", load),
  from.timer("timeout", 1000)
] } })`,
    `import { Machine } from "@typeonce/effect-machine"
Machine.make({ initial: (to) => to.One() }).handle({
  One: { invoke: (from) => from.effect("load", load) },
  Two: { invoke: (from) => from.effect("load", load) }
})`,
    `import { Machine } from "@typeonce/effect-machine"
Machine.make({ initial: (to) => to.Ready() }).handle({ Ready: { invoke: (from) => [
  from.effect(makeId(), load),
  from.effect(makeId(), load)
] } })`,
    `import { Machine } from "@typeonce/effect-machine"
Machine.make({ initial: (to) => to.Ready() }).handle({ Ready: { invoke: (from) => {
  let id = "first"
  const first = from.effect(id, load)
  id = "second"
  const second = from.effect(id, load)
  return [first, second]
} } })`,
    `import { Machine } from "@typeonce/effect-machine"
Machine.make({ initial: (to) => to.Ready() }).handle({ Ready: { invoke: (from) => from.effect("outer", () => [
  from.effect("nested", load),
  from.effect("nested", load)
]) } })`
  ],
  invalid: [
    {
      code: `import { Machine } from "@typeonce/effect-machine"
Machine.make({ initial: (to) => to.Ready() }).handle({ Ready: { invoke: (from) => [
  from.effect("load", load),
  from.timer("load", 1000)
] } })`,
      errors: [{ messageId: "conflictingLifecycle" }]
    },
    {
      code: `import { Machine } from "@typeonce/effect-machine"
const address = Machine.childAddress("worker")
Machine.make({ initial: (to) => to.Ready() }).handle({ Ready: { invoke: (from) => [
  from.logic("first", { address, logic }),
  from.logic("second", { address, logic })
] } })`,
      errors: [{ messageId: "conflictingAddress" }]
    },
    {
      code: `import { Machine } from "@typeonce/effect-machine"
const Child = Machine.child("worker", childMachine)
Machine.make({ initial: (to) => to.Ready() }).handle({ Ready: { invoke: (from) => [
  from.child(Child),
  from.child(Child)
] } })`,
      errors: [{ messageId: "conflictingBoth" }]
    },
    {
      code: `import { Machine } from "@typeonce/effect-machine"
const id = "same"
Machine.make({ initial: (to) => to.Ready() }).handle({ Ready: { invoke: (from) => {
  const first = from.effect(id, load).onDone((to) => to.none)
  const second = from.stream(\`same\`, stream)
  const invocations = [first, second]
  return invocations
} } })`,
      errors: [{ messageId: "conflictingLifecycle" }]
    },
    {
      code: `import { Machine } from "@typeonce/effect-machine"
const Child = Machine.child("shared", childMachine)
Machine.make({ initial: (to) => to.Ready() }).handle({ Ready: { invoke: (from) => [
  from.effect("shared", load),
  from.child(Child)
] } })`,
      errors: [{ messageId: "conflictingLifecycle" }]
    }
  ]
})
