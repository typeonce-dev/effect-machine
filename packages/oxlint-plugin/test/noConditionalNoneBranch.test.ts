import { RuleTester } from "oxlint/plugins-dev"
import { describe, it } from "vitest"
import plugin from "../src/index.js"

RuleTester.describe = describe
RuleTester.it = it

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } }
})

const rule = plugin.rules["no-conditional-none-branch"]

const make = (branches: string, transition: string, machine = "Machine") =>
  `import { ${machine === "Machine" ? "Machine" : `Machine as ${machine}`} } from "@typeonce/effect-machine"
${machine}.make({ branches: { ${branches} } }).handle({ states: { Editing: { on: { Submitted: ${transition} } } } })`

const submit = `submit: { review: { target: "Reviewing" }, incomplete: { none: true } }`

tester.run("no-conditional-none-branch", rule, {
  valid: [
    // Targeted branches only.
    make(
      `submit: { review: { target: "Reviewing" }, editing: { target: "Editing" } }`,
      `{ branches: "submit", resolve: ({ state, select }) => state.ok ? select.review() : select.editing() }`
    ),
    // Unconditional none selection.
    make(submit, `{ branches: "submit", resolve: ({ select }) => select.incomplete() }`),
    make(submit, `{ branches: "submit", resolve: ({ select }) => { return select.incomplete() } }`),
    // Declinable resolvers may still select none deliberately.
    make(
      submit,
      `{ branches: "submit", declinable: true, resolve: ({ state, select, decline }) => state.ok ? select.review() : state.draft ? select.incomplete() : decline() }`
    ),
    make(
      submit,
      `{ branches: "submit", declinable: true, resolve: ({ state, select }) => state.ok ? select.review() : select.incomplete() }`
    ),
    // A non-literal declinable flag is not guessed.
    make(
      submit,
      `{ branches: "submit", declinable: flag, resolve: ({ state, select }) => state.ok ? select.review() : select.incomplete() }`
    ),
    // Conditional choice between targeted branches in a group that also declares none.
    make(
      submit,
      `{ branches: "submit", resolve: ({ state, select }) => state.ok ? select.review() : select.review({ data: {} }) }`
    ),
    // A different group whose branch shares the none key name.
    make(
      `${submit}, other: { incomplete: { target: "Editing" }, review: { target: "Reviewing" } }`,
      `{ branches: "other", resolve: ({ state, select }) => state.ok ? select.review() : select.incomplete() }`
    ),
    // A shadowed selector is not the resolver's select.
    make(
      submit,
      `{ branches: "submit", resolve: ({ state, select }) => state.ok ? select.review() : ((select) => select.incomplete())(other) }`
    ),
    // Without a Machine import nothing is a machine definition.
    `const Machine = { make: (_: unknown) => ({ handle: (_: unknown) => undefined }) }
Machine.make({ branches: { ${submit} } }).handle({ states: { Editing: { on: { Submitted: { branches: "submit", resolve: ({ state, select }) => state.ok ? select.review() : select.incomplete() } } } } })`,
    // An unrelated object outside a machine definition.
    `import { Machine } from "@typeonce/effect-machine"
const config = { branches: "submit", resolve: ({ state, select }) => state.ok ? select.review() : select.incomplete() }`
  ],
  invalid: [
    {
      code: make(
        submit,
        `{ branches: "submit", resolve: ({ state, select }) => state.ok ? select.review() : select.incomplete() }`
      ),
      errors: [{ messageId: "conditionalNoneBranch" }]
    },
    {
      code: make(
        submit,
        `{ branches: "submit", declinable: false, resolve: ({ state, select }) => state.ok ? select.review() : select.incomplete() }`,
        "StateMachine"
      ),
      errors: [{ messageId: "conditionalNoneBranch" }]
    },
    {
      code: make(
        submit,
        `{ branches: "submit", resolve: ({ state, select: { review, incomplete: skip } }) => state.ok ? review() : skip() }`
      ),
      errors: [{ messageId: "conditionalNoneBranch" }]
    },
    {
      code: make(
        `submit: { review: { target: "Reviewing" }, editing: { target: "Editing" }, "incomplete": { none: true } }`,
        `{ branches: "submit", resolve: ({ state, select }) => state.ok ? select.review() : state.draft ? select.editing() : select.incomplete() }`
      ),
      errors: [{ messageId: "conditionalNoneBranch" }]
    },
    {
      code: make(
        submit,
        `{ branches: "submit", resolve: ({ state, select }) => {
  if (state.ok) return select.review()
  return select.incomplete()
} }`
      ),
      errors: [{ messageId: "conditionalNoneBranch" }]
    },
    {
      code: make(
        submit,
        `{ branches: "submit", resolve(context) {
  if (!context.state.ok) {
    return context.select.incomplete()
  } else {
    return context.select.review()
  }
} }`
      ),
      errors: [{ messageId: "conditionalNoneBranch" }]
    },
    {
      code: `import * as EM from "@typeonce/effect-machine"
const definition = EM.Machine.make({ branches: { ${submit} } })
export const machine = definition.handle({ states: { Editing: { states: { Draft: { on: {
  Submitted: { branches: "submit", resolve: ({ state, select }) => state.ok ? select.review() : select.incomplete.from() }
} } } } } })`,
      errors: [{ messageId: "conditionalNoneBranch" }]
    },
    {
      code: make(
        `submit: { incomplete: { none: true }, skipped: { none: true }, review: { target: "Reviewing" } }`,
        `{ branches: "submit", resolve: ({ state, select }) => state.ok ? select.review() : state.draft ? select.incomplete() : select.skipped() }`
      ),
      errors: [{ messageId: "conditionalNoneBranch" }, { messageId: "conditionalNoneBranch" }]
    }
  ]
})
